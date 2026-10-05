// BRINGING THE STORE CURRENT, ON THE AGENT'S REQUEST.
//
// The store is a SNAPSHOT: it holds what the sessions contained when it was last built, so a session that is still
// being written -- including this one -- is only as fresh as that build. `system1_sessions { action: 'refresh' }` is how
// an agent closes that gap, from inside the conversation, without a shell.
//
// IT RUNS IN ITS OWN PROCESS, and that is not a preference. The builder decodes session logs by piping them through
// `zstd` with `spawnSync`, and one 33 MB living session takes tens of seconds to refold: run in-process it would block
// the harness -- including the very session being measured -- for the duration. A child process costs a pid and keeps
// the observer out of its own subject's way.
//
// IT PRESERVES THE STORE'S MODE. `--text` and the tokenizer are read from the store's own `meta`, so a refresh
// maintains the store that exists instead of silently switching it to word search or dropping the mirror. A store that
// does not exist yet is built with the defaults.
//
// ONE AT A TIME. A second call while a rebuild runs reports the running one rather than starting a rival writer on the
// same file -- the index path has a single owner by design, and the message says which pid holds it.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defaultIndexPath, metaOf } from './store.js'

const SCRIPT = fileURLToPath(new URL('../bin/session-index.mjs', import.meta.url))

/** The rebuild this process would run, exposed so a caller can report or test it. */
export function refreshScriptPath() {
    return SCRIPT
}

let running = null

/**
 * Rebuild the store incrementally, from a child process.
 *
 * @returns a value the tool returns as-is: either a finished rebuild (with its own last lines kept verbatim), or a
 *          rebuild still running -- because a caller must never be told "refreshed" when nothing has finished.
 */
export async function refreshIndex({ out = defaultIndexPath(), sessionsDir = undefined, timeoutMs = 120000, spawnImpl = spawn } = {}) {
    if (running !== null) {
        return {
            refreshing: true,
            pid: running.pid,
            elapsedMs: Date.now() - running.startedAt,
            problems: [`a rebuild is already running in pid ${running.pid}; this call did NOT start a second one`],
        }
    }
    const meta = await metaOf(out)
    const withText = meta.text_indexed === '1'
    const tokenizer = meta.tokenizer === 'unicode61' ? 'unicode61' : 'trigram'
    const args = [SCRIPT, 'build', '--incremental', '--out', out]
    if (sessionsDir !== undefined) args.push('--sessions', sessionsDir)
    if (withText) args.push('--text')
    args.push('--tokenizer', tokenizer)

    const startedAt = Date.now()
    const child = spawnImpl(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    running = { pid: child.pid, startedAt }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    // THE PROGRESS COUNTER GOES TO STDERR, so it is collected but never mixed into the summary a reader sees.
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    // THE TIMEOUT IS CLEARED WHEN THE CHILD CLOSES, and it is unref'd as well. A timer left armed holds the event loop
    // open for its whole duration -- measured here as a test file that passed every case and then took 120 s to exit --
    // and in the harness it would be a live handle per refresh.
    let timer = null
    const closed = new Promise((resolve) => {
        const settle = (code) => { running = null; if (timer !== null) clearTimeout(timer); resolve(code) }
        child.on('close', (code) => settle(typeof code === 'number' ? code : -1))
        child.on('error', () => settle(-1))
    })
    const outcome = await Promise.race([closed, new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
        timer.unref?.()
    })])
    if (outcome === 'timeout') {
        return {
            refreshing: true,
            pid: child.pid,
            elapsedMs: Date.now() - startedAt,
            tokenizer,
            problems: [`the rebuild is still running after ${Math.round(timeoutMs / 1000)} s (pid ${child.pid}); it finishes on its own and the store stays readable, so search again shortly`],
        }
    }

    const summary = stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    const first = summary.find((line) => /session\(s\) in the store/.test(line)) ?? ''
    const value = {
        refreshing: false,
        pid: child.pid,
        elapsedMs: Date.now() - startedAt,
        tokenizer,
        summary,
    }
    const captured = (re, from) => {
        const found = re.exec(from)
        return found === null ? undefined : Number(found[1])
    }
    const sessions = captured(/^(\d+) session/, first)
    const refolded = captured(/refolded (\d+)/, first)
    const skipped = captured(/skipped (\d+)/, first)
    if (sessions !== undefined) value.count = sessions
    if (refolded !== undefined) value.refolded = refolded
    if (skipped !== undefined) value.skipped = skipped
    const size = /size:\s*([\d.]+) MB/.exec(summary.find((line) => /^size:/.test(line)) ?? '')
    if (size !== null) value.storeSizeMb = Number(size[1])
    const mode = /search:\s*(\S+)/.exec(summary.find((line) => /^search:/.test(line)) ?? '')
    if (mode !== null) value.searchMode = mode[1]
    if (outcome !== 0) {
        const detail = stderr.trim().split('\n').slice(-2).join(' ')
        value.problems = [`the rebuild exited with code ${outcome}${detail === '' ? '' : ': ' + detail}`]
    }
    return value
}
