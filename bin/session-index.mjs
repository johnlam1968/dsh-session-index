#!/usr/bin/env node
// THE COMMAND LINE: build, find, search and stats, over the store in `../lib/`.
//
// It is deliberately thin. Everything it does is a call into `lib/build.js` (the builder) or `lib/store.js` (the read
// side), so the CLI cannot drift from what the plugin's service does -- the same functions answer both.

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_INDEX, DEFAULT_SESSIONS_DIR, buildIndex, readCounts } from '../lib/build.js'
import { findSessions, searchSessions } from '../lib/store.js'

const ms = (t) => `${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(0)} ms`

async function main(argv) {
    const [command, ...rest] = argv
    const flag = (name, fallback) => {
        const at = rest.indexOf(`--${name}`)
        return at === -1 ? fallback : rest[at + 1]
    }
    const out = flag('out', DEFAULT_INDEX)
    if (command === 'build') {
        const started = process.hrtime.bigint()
        const result = buildIndex({
            sessionsDir: flag('sessions', DEFAULT_SESSIONS_DIR),
            out,
            withText: rest.includes('--text'),
            incremental: rest.includes('--incremental'),
            // `--no-fts` builds the same store WITHOUT the mirror: a real store that searches by scan, which is how the
            // scan path stays exercised rather than assumed.
            fts: !rest.includes('--no-fts'),
            tokenizer: flag('tokenizer', 'trigram'),
            onProgress: (done, total) => process.stderr.write(`  ${done}/${total}\r`),
        })
        console.log(`${result.sessions} session(s) in the store; refolded ${result.refolded}, skipped ${result.skipped} unchanged`
            + `${result.schemaMoved ? ' (the SCHEMA moved, so every receipt was void)' : ''}`
            + `${result.modeChanged && !result.schemaMoved ? ' (the TEXT MODE changed, so every receipt was void)' : ''}`
            + `, in ${ms(started)} -> ${result.out}`)
        console.log(`  cost: refold ${(result.refoldMs / 1000).toFixed(1)} s (decode ${(result.decodeMs / 1000).toFixed(1)} s, fold ${(result.foldMs / 1000).toFixed(1)} s, insert ${(result.insertMs / 1000).toFixed(1)} s), mirror ${(result.mirrorMs / 1000).toFixed(1)} s`)
        console.log(`  search: ${result.searchMode}${result.searchMode === 'fts5' ? ` (${result.tokenizer}), ${result.ftsRows} mirrored row(s)${result.ftsRebuilt ? ' (rebuilt whole)' : result.ftsMaintained > 0 ? ` (maintained for ${result.ftsMaintained} session(s))` : ' (unchanged)'}` : ' -- no FTS5 mirror, text is matched by scan'}`)
        console.log(`  with a session/title event: ${result.titled} | without: ${result.untitled}` +
            (result.untitled > 0 ? ' (those are the ones a title service must fold per request)' : ''))
        console.log(`  size: ${(statSync(out).size / 1048576).toFixed(1)} MB`)
        return 0
    }
    if (command === 'find') {
        const term = rest.find((a) => !a.startsWith('--') && a !== flag('out', null) && a !== flag('limit', null))
        if (term === undefined) { console.error('find needs a term'); return 2 }
        const started = process.hrtime.bigint()
        const rows = await findSessions(term, { path: out, limit: Number(flag('limit', 20)) })
        console.log(`${rows.length} session(s) matching ${JSON.stringify(term)} in ${ms(started)}`)
        for (const row of rows) {
            console.log(`  ${row.id}`)
            console.log(`    title: ${row.title === null ? '(none)' : row.title}${row.title_source === null ? '' : ` [${row.title_source}]`}`)
            console.log(`    cwd:   ${row.cwd ?? '?'}`)
            console.log(`    ${row.asks} asks, ${row.messages} messages, ${row.tool_calls} tool calls, ${new Date(Number(row.created_at ?? 0)).toISOString().slice(0, 16)}`)
        }
        return 0
    }
    if (command === 'search') {
        const term = rest.find((a) => !a.startsWith('--') && a !== flag('out', null) && a !== flag('limit', null))
        if (term === undefined) { console.error('search needs a term'); return 2 }
        const started = process.hrtime.bigint()
        const found = await searchSessions(term, { path: out, limit: Number(flag('limit', 20)) })
        console.log(`${found.total} session(s) matching ${JSON.stringify(found.term)} in ${ms(started)}`
            + (found.textIndexed
                ? ` (${found.searchMode === 'fts5-trigram' ? 'FTS5 trigram mirror' : found.searchMode === 'fts5' ? 'FTS5 word mirror' : 'LIKE scan'}: message text, reasoning, tool results and tool arguments)`
                : ' -- CONVERSATION TEXT IS NOT INDEXED in this store, so only titles, ids and directories were compared; rebuild with --text to search what was said and what tools returned'))
        for (const row of found.rows) {
            console.log(`  ${row.id}`)
            console.log(`    title: ${row.title === null || row.title === undefined ? '(none)' : row.title}`)
            console.log(`    cwd:   ${row.cwd ?? '?'}`)
            console.log(`    matched in: ${row.matchedIn}${row.hits > 0 ? ` (${row.hits} message(s))` : ''}`)
            if (row.snippet !== undefined && row.snippet !== '') console.log(`    …${row.snippet.split('\n').join(' ')}…`)
        }
        return 0
    }
    if (command === 'stats') {
        const one = readCounts(out)
        const size = (statSync(out).size / 1048576).toFixed(1)
        console.log(`${one.sessions} session(s), ${one.titled} titled, ${one.asks} asks, ${one.shadowed} shadowed message(s), ${size} MB`)
        return 0
    }
    console.error('usage: session-index.mjs build|find|search|stats [--out FILE] [--sessions DIR] [--text] [--incremental] [--limit N]')
    return 2
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop())) process.exit(await main(process.argv.slice(2)))
