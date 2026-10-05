// THE REFRESH ACTION: the store is a snapshot, so an agent needs a way to bring it current.
//
// These tests drive the module directly, with a FAKE CHILD PROCESS, because what matters is the contract: that the
// rebuild happens in another process, incrementally, in the store's own mode -- and that a caller is never told
// "refreshed" for work that has not finished.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIndex } from '../lib/build.js'
import { refreshIndex, refreshScriptPath } from '../lib/refresh.js'

const SUMMARY = [
    '499 session(s) in the store; refolded 2, skipped 497 unchanged, in 1500 ms -> /tmp/store.db',
    '  search: fts5 (trigram), 91247 mirrored row(s) (unchanged)',
    '  with a session/title event: 486 | without: 13 (those are the ones a title service must fold per request)',
    '  size: 617.8 MB',
].join('\n') + '\n'

/** A child that behaves like `spawn`'s, without running anything. */
function fakeChild({ stdout = '', stderr = '', code = 0, pid = 4242, hold = false } = {}) {
    const child = new EventEmitter()
    child.pid = pid
    child.stdout = Readable.from([stdout])
    child.stderr = Readable.from([stderr])
    child.release = () => child.emit('close', code)
    if (!hold) setImmediate(() => child.emit('close', code))
    return child
}

function store(withText = true) {
    const root = mkdtempSync(join(tmpdir(), 'refresh-'))
    const dir = join(root, '--p--', 'session-a')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl'), [
        JSON.stringify({ type: 'session', version: 4, id: 'session-a', createdAt: 5, cwd: '/tmp/p' }),
        JSON.stringify({ type: 'user/message', seq: 1, time: 1, data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'hello there' }] } }),
    ].join('\n') + '\n')
    const out = join(root, 'store.db')
    buildIndex({ sessionsDir: root, out, withText, tokenizer: 'trigram' })
    return { root, out }
}

test('the rebuild runs as a CHILD PROCESS, incrementally, in the store\'s own mode', async () => {
    const s = store(true)
    try {
        const seen = []
        const value = await refreshIndex({
            out: s.out,
            spawnImpl: (command, args) => { seen.push({ command, args }); return fakeChild({ stdout: SUMMARY }) },
        })
        assert.equal(seen.length, 1)
        // ITS OWN PROCESS: the rebuild decodes tens of MB of logs and must not block the harness it observes
        assert.equal(seen[0].command, process.execPath)
        assert.equal(seen[0].args[0], refreshScriptPath())
        assert.ok(seen[0].args.includes('--incremental'), 'a refresh refolds only what changed')
        assert.ok(seen[0].args.includes('--out') && seen[0].args.includes(s.out))
        // THE MODE IS THE STORE'S, not a default: a refresh must not silently switch a text store to word search
        assert.ok(seen[0].args.includes('--text'), 'this store holds text, so the refresh keeps it')
        assert.deepEqual(seen[0].args.slice(seen[0].args.indexOf('--tokenizer'), seen[0].args.indexOf('--tokenizer') + 2), ['--tokenizer', 'trigram'])
        // AND THE REPLY DISTINGUISHES FINISHED FROM RUNNING
        assert.equal(value.refreshing, false)
        assert.equal(value.refolded, 2)
        assert.equal(value.skipped, 497)
        assert.equal(value.count, 499)
        assert.equal(value.storeSizeMb, 617.8)
        assert.equal(value.searchMode, 'fts5')
        assert.equal(value.pid, 4242)
        assert.equal(value.problems, undefined)
        assert.ok(value.summary.some((line) => line.startsWith('size:')), 'the rebuild\'s own lines are kept verbatim')
    } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('a store with NO text is refreshed without --text, so the mode is not invented', async () => {
    const s = store(false)
    try {
        const seen = []
        await refreshIndex({ out: s.out, spawnImpl: (_c, args) => { seen.push(args); return fakeChild({ stdout: SUMMARY }) } })
        assert.ok(!seen[0].includes('--text'), 'a store without text must not be rebuilt as if it had some')
    } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('a second refresh does NOT start a rival writer on the same store', async () => {
    const s = store(true)
    try {
        const held = fakeChild({ stdout: SUMMARY, hold: true })
        const first = await refreshIndex({ out: s.out, timeoutMs: 30, spawnImpl: () => held })
        // a rebuild that outlives the call is reported as RUNNING, never as done
        assert.equal(first.refreshing, true)
        assert.equal(first.pid, 4242)
        assert.match(first.problems.join(' '), /still running/)
        const second = await refreshIndex({ out: s.out, spawnImpl: () => { throw new Error('must not spawn a second child') } })
        assert.equal(second.refreshing, true)
        assert.match(second.problems.join(' '), /already running in pid 4242/)
        held.release()
        await new Promise((resolve) => setImmediate(resolve))
        const third = await refreshIndex({ out: s.out, spawnImpl: () => fakeChild({ stdout: SUMMARY }) })
        assert.equal(third.refreshing, false, 'once it closes, the next call may run again')
    } finally { rmSync(s.root, { recursive: true, force: true }) }
})

test('a rebuild that FAILS is a named problem carrying the child\'s own last words', async () => {
    const s = store(true)
    try {
        const value = await refreshIndex({
            out: s.out,
            spawnImpl: () => fakeChild({ stdout: '', stderr: 'progress\r\nerror: the store is locked by pid 9\n', code: 2 }),
        })
        assert.equal(value.refreshing, false)
        assert.match(value.problems.join(' '), /exited with code 2/)
        assert.match(value.problems.join(' '), /locked by pid 9/)
    } finally { rmSync(s.root, { recursive: true, force: true }) }
})
