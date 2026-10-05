// THE ENTRY POINT ITSELF, because a module can be perfect while the thing the docs tell people to run is broken.
//
// Measured: the CLI lost two imports when it was split out of the builder's file, so `stats` threw
// `statSync is not defined` while every module test passed. Nothing here tests a module -- it RUNS the command.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/session-index.mjs', import.meta.url))

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'session-index-cli-'))
    const dir = join(root, '--p--', 'session-a')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl'), [
        JSON.stringify({ type: 'session', version: 4, id: 'session-a', createdAt: 1789873194109, cwd: '/home/john/proj' }),
        JSON.stringify({ type: 'user/message', seq: 1, time: 1, data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'a phrase the scan and the mirror both find' }] } }),
    ].join('\n') + '\n')
    return root
}

test('the CLI builds, reports stats, finds and searches -- run as a command, not imported', () => {
    const root = fixture()
    const out = join(root, 'store.db')
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
    try {
        const build = run('build', '--out', out, '--sessions', root, '--text', '--tokenizer', 'trigram')
        assert.equal(build.status, 0, build.stderr)
        assert.match(build.stdout, /session\(s\) in the store/)
        assert.match(build.stdout, /cost: refold/)
        assert.match(build.stdout, /search: fts5 \(trigram\)/)

        const stats = run('stats', '--out', out)
        assert.equal(stats.status, 0, stats.stderr)
        assert.match(stats.stdout, /1 session\(s\), 0 titled/)

        const find = run('find', 'session-a', '--out', out)
        assert.equal(find.status, 0, find.stderr)
        assert.match(find.stdout, /session-a/)

        const search = run('search', 'phrase the scan', '--out', out)
        assert.equal(search.status, 0, search.stderr)
        assert.match(search.stdout, /session\(s\) matching/)
        assert.match(search.stdout, /FTS5 trigram mirror/)

        // and an unknown command says what the commands are, rather than doing nothing
        const usage = run('nonsense')
        assert.equal(usage.status, 2)
        assert.match(usage.stderr, /usage: session-index\.mjs build\|find\|search\|stats/)
    } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the CLI builds a store WITHOUT the mirror when asked, and says the mechanism', () => {
    const root = fixture()
    const out = join(root, 'scan.db')
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
    try {
        const build = run('build', '--out', out, '--sessions', root, '--text', '--no-fts')
        assert.equal(build.status, 0, build.stderr)
        assert.match(build.stdout, /no FTS5 mirror/)
        const search = run('search', 'phrase the scan', '--out', out)
        assert.match(search.stdout, /LIKE scan/)
    } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the summary survives REDIRECTION, not only a pipe -- the CLI must not exit out from under its own output', () => {
    // Measured: the CLI ended with `process.exit(...)`, and with stdout a FILE the summary it had just built was thrown
    // away -- a full rebuild whose log contained nothing but the progress counter, while the build itself had
    // succeeded. `process.exitCode` is the fix: the process ends when the loop drains, so everything written is flushed.
    const root = fixture()
    const out = join(root, 'redirected.db')
    const log = join(root, 'build.log')
    try {
        const fd = openSync(log, 'w')
        const run = spawnSync(process.execPath, [CLI, 'build', '--out', out, '--sessions', root, '--text'], { stdio: ['ignore', fd, 'ignore'] })
        closeSync(fd)
        assert.equal(run.status, 0)
        const text = readFileSync(log, 'utf8')
        assert.match(text, /session\(s\) in the store/, 'the summary reached the file')
        assert.match(text, /search: fts5/)
        assert.match(text, /size:/)
    } finally { rmSync(root, { recursive: true, force: true }) }
})
