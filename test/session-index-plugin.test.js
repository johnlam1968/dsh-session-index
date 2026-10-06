// THE STORE AS A PLUGIN: the capability behind a service name, with no schema crossing the boundary.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, HOST_SERVICES, SESSION_INDEX_SERVICE, apply, createSessionIndex, name } from '../index.js'
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

test('the package IS a plugin, and the service is a Service SUBCLASS -- which is what the catalogue needs', async () => {
    assert.equal(name, 'session-index')
    assert.equal(SESSION_INDEX_SERVICE, 'localSessionIndex')
    const { Service } = await import('@deepseek-ai/cordis')
    const mounted = []
    let injected = null
    const register = (tool) => { /* the registry is not the subject here */ }
    // A HOST WITH NO TOOL REGISTRY MUST NOT BREAK `apply`: the service is the capability, and the tools are an addition
    // that only exists where a registry does.
    const base = {
        plugin: (plugin, config) => { mounted.push([plugin, config]); return { dispose() {} } },
        get: () => undefined,
    }
    apply({ ...base, inject: (names, callback) => { injected = names; callback({}) } }, { path: '/tmp/does-not-matter.db' })
    assert.deepEqual(injected, ['tools'], 'the tools are registered through the tool registry')
    let registered = []
    apply({ ...base, inject: (names, callback) => { injected = names; callback({ tools: { register: (tool) => { registered.push(tool.name); return () => {} } } }) } }, { path: '/tmp/does-not-matter.db' })
    assert.deepEqual(registered.sort(), ['session_index_list', 'session_index_read', 'session_index_refresh', 'session_index_search'])
    // THE DOCUMENTED FORM: a CLASS is mounted and it extends `Service`, where the audit measured that a plain
    // `ctx.provide` object does not reach the live Service catalogue (F107).
    assert.equal(mounted.length, 2, 'each apply mounts the class once')
    const [plugin, config] = mounted[0]
    assert.equal(typeof plugin, 'function', 'a class is mounted, not a plain object')
    assert.equal(plugin.name, 'LocalSessionIndex')
    assert.ok(plugin.prototype instanceof Service, 'and it IS a Service subclass')
    assert.equal(config.path, '/tmp/does-not-matter.db', 'the row config reaches the class')
    assert.equal(typeof Config, 'function', 'the row declares a config schema')
    // AND NOTHING ABOUT HOW IT IS STORED CROSSES THE BOUNDARY: no SQL, no table names, no file layout.
    const { LocalSessionIndex } = await import('../index.js')
    const capability = Object.getOwnPropertyNames(LocalSessionIndex.prototype).filter((k) => k !== 'constructor')
    assert.deepEqual(capability, [], 'the class adds no methods of its own: it delegates to the same factory')
    // A REAL Context, because that is the evidence that matters: the constructor must REGISTER the service under its
    // key, which is the thing the audit measured missing from the plain-object form.
    const { Context } = await import('@deepseek-ai/cordis')
    const ctx = new Context()
    new LocalSessionIndex(ctx, { path: '/tmp/x.db' })
    // MEASURED: the service is registered by the constructor, and `ctx.get` answers with a PROXY of it until the class
    // is mounted -- after which it is the instance itself. Either way the capability is reachable under the key, which
    // is exactly what the plain-object form did NOT do in the live catalogue (F107).
    assert.equal(typeof ctx.get(SESSION_INDEX_SERVICE)?.search, 'function', 'registered by the constructor')
    ctx.plugin(LocalSessionIndex, { path: '/tmp/x.db' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const mountedService = ctx.get(SESSION_INDEX_SERVICE)
    assert.ok(mountedService instanceof LocalSessionIndex, 'and mounted as the class, which is what the catalogue lists')
    const capabilityKeys = Object.keys(mountedService).filter((k) => !k.startsWith('_') && k !== 'ctx' && k !== 'name').sort()
    assert.deepEqual(capabilityKeys, ['build', 'counts', 'find', 'list', 'meta', 'path', 'read', 'refresh', 'row', 'search'], 'the capability, and nothing about how it is stored (`counts` says how many rows a list is drawn from, and how many of them are subagent runs)')
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

test('the declared host inventory is exactly what the source reaches', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
    // A SERVICE IS REACHED BY `get` OR BY `inject`, and an inventory that counted only one of them would be a
    // half-truth: this package injects `tools` and reads nothing else.
    const reached = []
    for (const m of source.matchAll(/ctx\.get\('([A-Za-z]+)'\)|inject\(\[([^\]]+)\]/g)) {
        if (m[1] !== undefined) reached.push(m[1])
        else for (const name of m[2].split(',')) reached.push(name.trim().replace(/['"]/g, ''))
    }
    assert.deepEqual([...new Set(reached)].sort(), [...HOST_SERVICES].sort(), 'HOST_SERVICES is not a wish: it is the source')
})
