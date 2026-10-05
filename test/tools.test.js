// THE FOUR AGENT-FACING TOOLS, and the rule that they declare everything they emit.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIndex } from '../lib/build.js'
import { TOOL_NAMES, TOOL_OUTPUT, createTools } from '../lib/tools.js'
import { createSessionIndex } from '../index.js'

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'session-index-tools-'))
    const dir = join(root, '--home-john-proj--', 'session-a')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl'), [
        JSON.stringify({ type: 'session', version: 4, id: 'session-a', createdAt: 1789873194109, cwd: '/home/john/proj' }),
        JSON.stringify({ type: 'user/message', seq: 1, time: 1, data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'please look at the deploy script' }] } }),
        JSON.stringify({ type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'the deploy script is fine' }] } } }),
        JSON.stringify({ type: 'tool/call', seq: 3, time: 3, data: { callId: 'c1', name: 'bash', arguments: '{"command":"cat deploy.sh"}' } }),
        JSON.stringify({ type: 'tool/result', seq: 4, time: 4, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'an unusual phrase from a tool' }] } } }),
        // a compaction withdraws seq 1 from the surface: the reader must COUNT that, not silently drop it. The span is
        // ONE event on purpose -- a span of 1..3 would withdraw the assistant reply too, which the first version of this
        // fixture did, and the reader was right to show nothing.
        JSON.stringify({ type: 'user/message', seq: 9, time: 9, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, data: { source: { kind: 'compact-checkpoint' }, content: 'summary of the above' } }),
    ].join('\n') + '\n')
    const path = join(root, 'store.db')
    buildIndex({ sessionsDir: root, out: path, withText: true, tokenizer: 'trigram' })
    return { root, path }
}

function toolNamed(tools, name) {
    const found = tools.find((t) => t.name === name)
    assert.ok(found, name + ' is registered')
    return found
}

test('the plugin offers list, read, search and refresh -- and declares every field they emit', async () => {
    const f = fixture()
    try {
        const tools = createTools({ service: createSessionIndex({ path: f.path, sessionsDir: f.root }) })
        assert.deepEqual(tools.map((t) => t.name).sort(), Object.values(TOOL_NAMES).sort())
        for (const defined of tools) {
            assert.equal(typeof defined.description, 'string')
            assert.ok(defined.description.length > 40, defined.name + ' explains itself')
            assert.equal(defined.output.schema, TOOL_OUTPUT)
        }
        const values = [
            await toolNamed(tools, TOOL_NAMES.list).execute({}),
            await toolNamed(tools, TOOL_NAMES.read).execute({ sessionId: 'session-a' }),
            await toolNamed(tools, TOOL_NAMES.search).execute({ query: 'unusual phrase' }),
        ]
        for (const value of values) {
            for (const key of Object.keys(value)) {
                assert.ok(TOOL_OUTPUT.properties[key] !== undefined, `${key} is emitted by ${value.action} and declared`)
            }
            assert.match(toolNamed(tools, TOOL_NAMES[value.action]).output.render({}, value)[0].text, /./)
        }
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('`read` shows the two voices, says what the surface withdrew, and pages the newest messages', async () => {
    const f = fixture()
    try {
        const read = toolNamed(createTools({ service: createSessionIndex({ path: f.path, sessionsDir: f.root }) }), TOOL_NAMES.read)
        const whole = await read.execute({ sessionId: 'session-a' })
        assert.equal(whole.session.id, 'session-a')
        assert.deepEqual(whole.messages.map((m) => m.role), ['assistant'])
        assert.match(whole.messages[0].text, /deploy script is fine/)
        // the operator's message was withdrawn by the compaction: counted, not silently dropped
        assert.equal(whole.coverage.withdrawn, 1)
        assert.equal(whole.coverage.other, 1, 'the checkpoint itself is a message event that is not a voice')
        assert.ok(whole.coverage.chars > 0)
        // and a page of the newest one still shows the message it found
        const paged = await read.execute({ sessionId: 'session-a', lastMessages: 1, messageChars: 0 })
        assert.equal(paged.messages.length, 1)
        // a session that is not in the store is NAMED, never an empty conversation
        const missing = await read.execute({ sessionId: 'nope' })
        assert.match(missing.problem, /no session "nope" in the index/)
        // an unknown argument is refused by name rather than ignored
        assert.match((await read.execute({ sessionId: 'session-a', nonsense: 1 })).problem, /unknown parameter `nonsense`/)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('`list` reports what the store holds, `search` says which mechanism answered, `refresh` runs', async () => {
    const f = fixture()
    try {
        const tools = createTools({ service: createSessionIndex({ path: f.path, sessionsDir: f.root }) })
        const listed = await toolNamed(tools, TOOL_NAMES.list).execute({ cwd: '/home/john/proj' })
        assert.equal(listed.count, 1)
        assert.equal(listed.sessions[0].id, 'session-a')
        assert.equal(listed.sessions[0].events > 0, true)
        const found = await toolNamed(tools, TOOL_NAMES.search).execute({ query: 'unusual phrase' })
        assert.equal(found.count, 1)
        assert.equal(found.searchMode, 'fts5-trigram')
        assert.equal(found.textIndexed, true)
        // a REAL incremental refresh of a tiny store: nothing changed, so nothing is refolded
        const refreshed = await toolNamed(tools, TOOL_NAMES.refresh).execute({ timeoutMs: 60000 })
        assert.equal(refreshed.action, 'refresh')
        assert.equal(refreshed.refreshing, false)
        assert.equal(refreshed.skipped >= 1, true)
        assert.equal(refreshed.refolded, 0)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('the tools REFUSE BY NAME: a bad argument, a missing session, an empty query, a store that is not there', async () => {
    const f = fixture()
    try {
        const tools = createTools({ service: createSessionIndex({ path: f.path, sessionsDir: f.root }) })
        const read = toolNamed(tools, TOOL_NAMES.read)
        const search = toolNamed(tools, TOOL_NAMES.search)
        const list = toolNamed(tools, TOOL_NAMES.list)
        assert.match((await read.execute({})).problems.join(' '), /`sessionId` is required/)
        assert.match((await search.execute({ query: '   ' })).problems.join(' '), /`query` is required/)
        assert.match((await list.execute({ limit: 'twenty' })).problem, /`limit` must be a number/)
        assert.match((await list.execute({ cwd: 7 })).problem, /`cwd` must be a string/)
        assert.match((await read.execute({ sessionId: 'session-a', kinds: 'operator' })).problem, /`kinds` must be an array/)
        // a store that was never built: a named absence, not an empty library
        const nowhere = createTools({ service: createSessionIndex({ path: join(f.root, 'nothing.db'), sessionsDir: f.root }) })
        const missing = await toolNamed(nowhere, TOOL_NAMES.list).execute({})
        assert.match(missing.problems.join(' '), /no readable store at/, 'a store that is not there is a PROBLEM, not an `problem`: the call was made')
        assert.equal((await toolNamed(nowhere, TOOL_NAMES.search).execute({ query: 'x' })).textIndexed, false, 'and search says the store holds no text rather than nothing at all')
        // and a session whose FILE is gone is named too, rather than read as an empty conversation
        const { rmSync: remove } = await import('node:fs')
        remove(join(f.root, '--home-john-proj--', 'session-a', 'session.v4.jsonl'))
        assert.match((await read.execute({ sessionId: 'session-a' })).problem, /could not be read/)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})
