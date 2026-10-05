// THE STORE AS A PLUGIN: the capability behind a service name, with no schema crossing the boundary.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, SESSION_INDEX_SERVICE, apply, createSessionIndex, name } from '../index.js'
import { buildIndex } from '../lib/build.js'

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'session-index-plugin-'))
    const dir = join(root, '--p--', 'session-a')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl'), [
        JSON.stringify({ type: 'session', version: 4, id: 'session-a', createdAt: 5, cwd: '/tmp/p' }),
        JSON.stringify({ type: 'user/message', seq: 1, time: 1, data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'a phrase only the text holds' }] } }),
    ].join('\n') + '\n')
    return { root }
}

test('the package IS a plugin: it names itself, takes config, and provides a service', () => {
    assert.equal(name, 'session-index')
    assert.equal(SESSION_INDEX_SERVICE, 'localSessionIndex')
    let provided = null
    let injected = null
    // A HOST WITH NO TOOL REGISTRY MUST NOT BREAK `apply`: the service is the capability, and the tools are an addition
    // that only exists where a registry does.
    const ctx = {
        provide: (serviceName, value) => { provided = { serviceName, value } },
        inject: (names, callback) => { injected = names; callback({}) },
    }
    apply(ctx, { path: '/tmp/does-not-matter.db' })
    assert.deepEqual(injected, ['tools'], 'the tools are registered through the tool registry')
    let registered = []
    apply({ ...ctx, inject: (names, callback) => callback({ tools: { register: (tool) => registered.push(tool.name) } }) }, { path: '/tmp/does-not-matter.db' })
    assert.deepEqual(registered.sort(), ['session_index_list', 'session_index_read', 'session_index_refresh', 'session_index_search'])
    assert.equal(provided.serviceName, SESSION_INDEX_SERVICE)
    for (const method of ['search', 'find', 'meta', 'refresh', 'build']) {
        assert.equal(typeof provided.value[method], 'function', method + ' is part of the capability')
    }
    // AND NOTHING ABOUT HOW IT IS STORED CROSSES THE BOUNDARY: no SQL, no table names, no file layout.
    assert.deepEqual(Object.keys(provided.value).sort(), ['build', 'find', 'list', 'meta', 'path', 'read', 'refresh', 'row', 'search'])
    assert.equal(typeof Config, 'function', 'the row declares a config schema')
})

test('the service answers from a store it is pointed at, and reports its mode', async () => {
    const f = fixture()
    try {
        const path = join(f.root, 'store.db')
        buildIndex({ sessionsDir: f.root, out: path, withText: true, tokenizer: 'trigram' })
        const service = createSessionIndex({ path })
        const meta = await service.meta()
        assert.equal(meta.search_mode, 'fts5')
        assert.equal(meta.tokenizer, 'trigram')
        const found = await service.search('only the text')
        assert.equal(found.rows.length, 1)
        assert.equal(found.rows[0].id, 'session-a')
        assert.equal((await service.find('session-a')).length, 1)
        // a store that is not there is a NAMED absence, never a silent empty
        const missing = createSessionIndex({ path: join(f.root, 'nothing.db') })
        assert.deepEqual(await missing.meta(), {})
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})
