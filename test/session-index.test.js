// THE INGESTER'S OWN FACTS, PINNED -- because all three of its first bugs were shape errors that produced a
// COMPLETE-LOOKING index: 498 sessions indexed, and every one of them with no cwd, no title provenance, and zero
// shadowed messages. Each assertion below is one of those failures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIndex, foldSession, readCounts, sessionFiles, sessionLines } from '../lib/build.js'
import { findSessions, listSessions, metaOf, searchSessions, subagentCounts } from '../lib/store.js'

/** A fixture session: header at the RECORD level, a title event whose `source` is an object, and a replace op. */
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'session-index-'))
    const id = 'session-abc'
    const dir = join(root, '--home-john-CodingProjects-zeroclaw-voice-proxy--', id)
    mkdirSync(dir, { recursive: true })
    const lines = [
        { type: 'session', version: 4, id, createdAt: 1789873194109, cwd: '/home/john/CodingProjects/zeroclaw-voice-proxy',
          parentSession: 'session-parent', origin: 'subagent', delegationDepth: 2, agentPreset: 'cordis', isSeeded: true },
        { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
        { type: 'user/message', seq: 2, time: 2, data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'push this repo' }] } },
        { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'done' }] } } },
        { type: 'tool/call', seq: 4, time: 4, data: { callId: 'c1', name: 'bash', arguments: '{"command":"git push"}' } },
        // a real result carries the call id in TWO places, and this one only in `message.toolCallId`
        { type: 'tool/result', seq: 5, time: 5, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'pushed' }] } } },
        // a compaction replaces the opening span, so seq 2 is withdrawn from the surface
        { type: 'user/message', seq: 9, time: 9, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 4 }, data: { source: { kind: 'compact-checkpoint' }, content: 'summary of the above' } },
        { type: 'session/title', seq: 10, time: 10, data: { title: 'Push repo to GitHub account', messageSeqs: [2], source: { kind: 'provider', provider: 'session-title-first-prompt-llm' } } },
    ]
    writeFileSync(join(dir, 'session.v4.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return { root, id, dir }
}

test('the header record carries cwd and createdAt at the TOP level, and it is where a session gets them', () => {
    const f = fixture()
    try {
        const { text, sha256 } = sessionLines(join(f.dir, 'session.v4.jsonl'))
        const { row } = foldSession({ id: f.id, path: 'x', version: 4, text, sha256, bytes: 1 })
        assert.equal(row.cwd, '/home/john/CodingProjects/zeroclaw-voice-proxy')
        assert.equal(row.created_at, 1789873194109)
        // THE FIELDS A DERIVED SCHEMA MISSES. `HeaderLine` declares all of these; reading one real file shows only cwd
        // and createdAt, so a session that names its parent or says it is a subagent looks like any other.
        assert.equal(row.parent_session, 'session-parent')
        assert.equal(row.origin, 'subagent')
        assert.equal(row.delegation_depth, 2)
        assert.equal(row.agent_preset, 'cordis')
        assert.equal(row.is_seeded, 1)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a title event keeps its TEXT, its set of asks and its provenance, which is an OBJECT on a real log', () => {
    const f = fixture()
    try {
        const { text, sha256 } = sessionLines(join(f.dir, 'session.v4.jsonl'))
        const { row } = foldSession({ id: f.id, path: 'x', version: 4, text, sha256, bytes: 1 })
        assert.equal(row.title, 'Push repo to GitHub account')
        assert.equal(row.has_title, 1)
        assert.deepEqual(JSON.parse(row.title_seqs), [2])
        assert.match(row.title_source, /provider/)
        assert.equal(row.explicit_rename, 0, 'a provider title is not an operator rename')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a REPLACED event is shadowed even though the replace op comes AFTER it', () => {
    const f = fixture()
    try {
        const { text, sha256 } = sessionLines(join(f.dir, 'session.v4.jsonl'))
        const { row, messages } = foldSession({ id: f.id, path: 'x', version: 4, text, sha256, bytes: 1 })
        // seq 2 (the ask) and seq 4 (the tool call is not a message; seq 3 the assistant message) are inside 2..4
        assert.equal(row.shadowed, 2, 'the ask at seq 2 and the assistant message at seq 3 are withdrawn')
        assert.equal(messages.filter((m) => m[7] === 1).length, 2)
        assert.equal(row.asks, 1, 'a withdrawn ask is still an ask that happened')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('reasoning is counted separately from visible text -- the 4.5x distinction, at the row level', () => {
    const f = fixture()
    try {
        const { text, sha256 } = sessionLines(join(f.dir, 'session.v4.jsonl'))
        const { row } = foldSession({ id: f.id, path: 'x', version: 4, text, sha256, bytes: 1 })
        assert.equal(row.reasoning_chars, 5)
        assert.equal(row.visible_chars, 'push this reposummary of the abovedone'.length)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a tool RESULT is kept and paired through the id it actually carries', () => {
    const f = fixture()
    try {
        const { text, sha256 } = sessionLines(join(f.dir, 'session.v4.jsonl'))
        const { results } = foldSession({ id: f.id, path: 'x', version: 4, text, sha256, bytes: 1 })
        assert.deepEqual(results, [[f.id, 'c1', 'pushed', 6, 0, 5]], 'paired by message.toolCallId, not by position, with the full length recorded')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a second build refolds only what CHANGED, so the warm-up is paid once', () => {
    const f = fixture()
    const out = join(f.root, 'index.db')
    try {
        const first = buildIndex({ sessionsDir: f.root, out })
        assert.equal(first.refolded, 1)
        assert.equal(first.skipped, 0)
        const warm = buildIndex({ sessionsDir: f.root, out, incremental: true })
        assert.equal(warm.schemaMoved, false)
        assert.equal(warm.skipped, 1, 'an unchanged file is skipped')
        assert.equal(warm.refolded, 0)
        assert.equal(readCounts(out).sessions, 1, 'and the store still holds it')
        // now the session grows, which is the only thing the harness does to a log
        const more = '\n' + JSON.stringify({ type: 'user/message', seq: 11, time: 11, data: { turn: 2, source: { kind: 'user' }, content: 'and again' } })
        writeFileSync(join(f.dir, 'session.v4.jsonl'), readFileSync(join(f.dir, 'session.v4.jsonl'), 'utf8') + more + '\n')
        const third = buildIndex({ sessionsDir: f.root, out, incremental: true })
        assert.equal(third.refolded, 1, 'the appended file is refolded')
        assert.equal(third.skipped, 0)
        assert.equal(readCounts(out).sessions, 1, 'and it REPLACES its row rather than duplicating it')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('search finds a phrase inside a CONVERSATION when the store was built with --text', async () => {
    const f = fixture()
    const out = join(f.root, 'index.db')
    try {
        buildIndex({ sessionsDir: f.root, out, withText: true })
        const found = await searchSessions('pushed', { path: out })
        assert.equal(found.textIndexed, true)
        assert.equal(found.rows.length, 1)
        assert.equal(found.rows[0].id, f.id)
        assert.equal(found.rows[0].hits, 1)
        // the phrase was in a TOOL RESULT -- the source is named, so a reader knows where the match came from
        assert.equal(found.rows[0].matchedIn, 'tool-result')
        assert.match(found.rows[0].snippet, /pushed/)
        // and a phrase in a MESSAGE is found by the other source, so neither path shadows the other
        const inMessage = await searchSessions('summary of the above', { path: out })
        assert.equal(inMessage.rows[0].id, f.id)
        assert.match(inMessage.rows[0].matchedIn, /text/)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('search SAYS SO when the store holds no message text, rather than reporting no matches', async () => {
    const f = fixture()
    const out = join(f.root, 'index.db')
    try {
        buildIndex({ sessionsDir: f.root, out })           // no --text
        assert.equal((await metaOf(out)).text_indexed, '0')
        const found = await searchSessions('pushed', { path: out })
        assert.equal(found.textIndexed, false, 'a store with no text cannot have searched any')
        assert.equal(found.rows.length, 0, 'and the phrase really is absent from titles, ids and directories')
        // the title path still works from the same store
        assert.equal((await searchSessions('GitHub account', { path: out })).rows[0].id, f.id)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a refold of ONE session maintains THAT session\'s mirror rows, and does not rebuild the mirror whole', async () => {
    // Measured on the real library before this: a single changed session cost refold 43.3 s + mirror 66.6 s, because
    // 91,380 mirror rows were deleted and re-inserted for 499 sessions of which exactly one had changed.
    const f = fixture()
    const out = join(f.root, 'index.db')
    try {
        const other = join(f.root, '--home-john-CodingProjects-other--', 'session-other')
        mkdirSync(other, { recursive: true })
        writeFileSync(join(other, 'session.v4.jsonl'), [
            JSON.stringify({ type: 'session', version: 4, id: 'session-other', createdAt: 6, cwd: '/home/john/CodingProjects/other' }),
            JSON.stringify({ type: 'user/message', seq: 1, time: 1, data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'untouched phrase lives here' }] } }),
        ].join('\n') + '\n')
        const first = buildIndex({ sessionsDir: f.root, out, withText: true })
        assert.equal(first.refolded, 2)
        assert.equal(first.ftsRebuilt, true, 'the first build has no mirror to maintain')
        assert.equal((await searchSessions('untouched phrase', { path: out })).rows.length, 1)
        appendFileSync(join(f.dir, 'session.v4.jsonl'), JSON.stringify({
            type: 'user/message', seq: 11, time: 11, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'a newly appended phrase' }] },
        }) + '\n')
        const second = buildIndex({ sessionsDir: f.root, out, incremental: true, withText: true })
        assert.equal(second.refolded, 1)
        assert.equal(second.ftsRebuilt, false, 'one changed session must NOT rebuild the mirror whole')
        assert.equal(second.ftsMaintained, 1)
        // AND IT APPENDS: measured before this existed, maintaining one 15,037-row session cost a 4,087 ms delete plus
        // a 4,413 ms insert, and a rowid map would have saved 92 ms of it -- so the WORK had to go, not the lookup.
        assert.equal(second.ftsAppended, 1, 'the receipt said how far the mirror was built, so only the new rows were mirrored')
        assert.equal(second.ftsReplaced, 0, 'nothing needed replacing')
        assert.equal((await searchSessions('a newly appended phrase', { path: out })).rows.length, 1, 'and the appended text IS searchable')
        assert.equal((await searchSessions('a newly appended phrase', { path: out })).rows.length, 1, 'the changed session is current')
        assert.equal((await searchSessions('untouched phrase', { path: out })).rows.length, 1, 'and the session nobody touched is still searchable')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('the FTS5 mirror answers, and the store says WHICH mechanism ran', async () => {
    const f = fixture()
    const out = join(f.root, 'index.db')
    try {
        const built = buildIndex({ sessionsDir: f.root, out, withText: true })
        assert.equal(built.searchMode, 'fts5')
        assert.equal(built.tokenizer, 'trigram', 'the default tokenizer is the one that SUBSTRING-matches')
        assert.ok(built.ftsRows > 0, 'the mirror holds the searchable rows')
        const meta = await metaOf(out)
        assert.equal(meta.search_mode, 'fts5')
        assert.equal(meta.tokenizer, 'trigram')
        assert.equal(meta.fts_rows, String(built.ftsRows))
        const found = await searchSessions('summary of the above', { path: out })
        assert.equal(found.searchMode, 'fts5-trigram')
        assert.equal(found.rows[0].id, f.id)
        // FTS5 marks the match inside its own snippet, so a reader can see WHAT matched
        assert.match(found.rows[0].snippet, /\[.*\]/)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('the query is handed to FTS5 as a LITERAL PHRASE, never as executable syntax', async () => {
    const f = fixture()
    const out = join(f.root, 'index.db')
    try {
        buildIndex({ sessionsDir: f.root, out, withText: true })
        // the stored message is "summary of the above": as a PHRASE, "summary AND above" is not in it; as SYNTAX it
        // would be (both tokens are present), so this pair distinguishes the two readings.
        assert.equal((await searchSessions('summary of the above', { path: out })).rows.length, 1)
        assert.equal((await searchSessions('summary AND above', { path: out })).rows.length, 0)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('TRIGRAM RESTORES THE SUBSTRING QUESTION that FTS5 alone changed (F99), and unicode61 does not', async () => {
    const f = fixture()
    const trigram = join(f.root, 'trigram.db')
    const words = join(f.root, 'words.db')
    try {
        buildIndex({ sessionsDir: f.root, out: trigram, withText: true })
        buildIndex({ sessionsDir: f.root, out: words, withText: true, tokenizer: 'unicode61' })
        // "ummary of the a" crosses token boundaries -- it is a SUBSTRING, not a word or a phrase
        const viaTrigram = await searchSessions('ummary of the a', { path: trigram })
        assert.equal(viaTrigram.searchMode, 'fts5-trigram')
        assert.equal(viaTrigram.rows.length, 1, 'a trigram mirror answers the LIKE question')
        const viaWords = await searchSessions('ummary of the a', { path: words })
        assert.equal(viaWords.searchMode, 'fts5')
        assert.equal(viaWords.rows.length, 0, 'a word index cannot: this is the question F99 recorded as changed')
        // and a whole phrase is found by both, so the difference is only about substrings
        assert.equal((await searchSessions('summary of the above', { path: words })).rows.length, 1)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a query SHORTER than a trigram falls back to the scan and says so, rather than a confident zero', async () => {
    const f = fixture()
    const out = join(f.root, 'index.db')
    try {
        buildIndex({ sessionsDir: f.root, out, withText: true })
        const found = await searchSessions('um', { path: out })
        assert.equal(found.searchMode, 'like', 'three characters is the smallest run a trigram stores')
        assert.equal(found.rows.length, 1, 'and the scan still answers it')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('changing the TOKENIZER recreates the mirror, and the TABLE is the truth rather than the receipt', async () => {
    // Measured on the real store: a build that predated the `tokenizer` receipt reported `trigram` in meta while the
    // table underneath was still unicode61, so the drop was skipped and the search quietly kept word semantics.
    const f = fixture()
    const out = join(f.root, 'index.db')
    const sqlOf = async (file) => {
        const { DatabaseSync } = await import('node:sqlite')
        const db = new DatabaseSync(file, { readOnly: true })
        try { return String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'search_fts'").get()?.sql ?? '') } finally { db.close() }
    }
    try {
        buildIndex({ sessionsDir: f.root, out, withText: true, tokenizer: 'unicode61' })
        assert.match(await sqlOf(out), /unicode61/)
        assert.equal((await searchSessions('ummary of the a', { path: out })).rows.length, 0, 'a word index cannot answer a substring')
        buildIndex({ sessionsDir: f.root, out, incremental: true, withText: true, tokenizer: 'trigram' })
        assert.match(await sqlOf(out), /trigram/, 'the table itself must change, not only the receipt')
        assert.equal((await searchSessions('ummary of the a', { path: out })).rows.length, 1, 'and now the substring answers')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a store built WITHOUT the mirror still searches, by scan, and says so', async () => {
    const f = fixture()
    const out = join(f.root, 'index.db')
    try {
        const built = buildIndex({ sessionsDir: f.root, out, withText: true, fts: false })
        assert.equal(built.searchMode, 'like')
        assert.equal(built.ftsRows, 0)
        const found = await searchSessions('summary of the above', { path: out })
        assert.equal(found.searchMode, 'like')
        assert.equal(found.rows[0].id, f.id, 'the scan finds the same phrase the mirror would')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a query with no searchable token does not throw and names the mechanism that ran', async () => {
    const f = fixture()
    const out = join(f.root, 'index.db')
    try {
        buildIndex({ sessionsDir: f.root, out, withText: true })
        const found = await searchSessions('***', { path: out })
        assert.ok(['fts5', 'fts5-trigram', 'like'].includes(found.searchMode), `unexpected search mode ${found.searchMode}`)
        assert.equal(found.rows.length, 0)
        const quoted = await searchSessions('say "hello" now', { path: out })
        assert.ok(['fts5', 'fts5-trigram', 'like'].includes(quoted.searchMode), 'a quoted phrase must not become syntax either')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('changing the TEXT MODE voids the receipts, because a receipt must cover the mode', async () => {
    const f = fixture()
    const out = join(f.root, 'index.db')
    try {
        buildIndex({ sessionsDir: f.root, out })
        const withText = buildIndex({ sessionsDir: f.root, out, incremental: true, withText: true })
        assert.equal(withText.modeChanged, true)
        assert.equal(withText.refolded, 1, 'every session is refolded so the text is actually stored')
        assert.equal((await metaOf(out)).text_indexed, '1')
        // and the reverse move re-refolds too, rather than leaving text behind that a later search would trust
        const back = buildIndex({ sessionsDir: f.root, out, incremental: true })
        assert.equal(back.modeChanged, true)
        assert.equal((await searchSessions('pushed', { path: out })).textIndexed, false)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('the index answers "the session in project X" BY CWD, in one query', async () => {
    const f = fixture()
    const out = join(f.root, 'index.db')
    try {
        const built = buildIndex({ sessionsDir: f.root, out })
        assert.equal(built.sessions, 1)
        assert.equal(built.titled, 1)
        // the handle that works: the project, not the title -- the title is a summary of the WORK
        const byCwd = await findSessions('zeroclaw-voice-proxy', { path: out })
        assert.equal(byCwd.length, 1)
        assert.equal(byCwd[0].id, f.id)
        assert.equal(byCwd[0].title, 'Push repo to GitHub account')
        // and the title is findable too, which is the capability the service cannot provide
        assert.equal((await findSessions('GitHub account', { path: out })).length, 1)
        assert.equal((await findSessions('nothing-like-this', { path: out })).length, 0)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('one session held in two format versions is indexed once, from the newer file', () => {
    const f = fixture()
    try {
        writeFileSync(join(f.dir, 'session.v3.jsonl'), '{}\n')
        const files = sessionFiles(f.root)
        assert.equal(files.length, 1)
        assert.equal(files[0].version, 4)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a session with NO mirror receipt is REPLACED, not appended -- correct rather than clever', async () => {
    const f = fixture()
    const out = join(f.root, 'receipt.db')
    try {
        buildIndex({ sessionsDir: f.root, out, withText: true })
        // the receipt is what makes an append safe: without it, "which rows are already mirrored" is unanswerable
        const { DatabaseSync } = await import('node:sqlite')
        const db = new DatabaseSync(out)
        db.exec('DELETE FROM mirror_state')
        db.close()
        appendFileSync(join(f.dir, 'session.v4.jsonl'), JSON.stringify({
            type: 'user/message', seq: 12, time: 12, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'after the receipt was lost' }] },
        }) + '\n')
        const rebuilt = buildIndex({ sessionsDir: f.root, out, incremental: true, withText: true })
        assert.equal(rebuilt.ftsReplaced, 1, 'no receipt means replace')
        assert.equal(rebuilt.ftsAppended, 0, 'and never append')
        assert.equal((await searchSessions('after the receipt was lost', { path: out })).rows.length, 1)
        // and the receipt was re-established, so the NEXT build appends again
        appendFileSync(join(f.dir, 'session.v4.jsonl'), JSON.stringify({
            type: 'user/message', seq: 13, time: 13, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'appended after the receipt returned' }] },
        }) + '\n')
        const next = buildIndex({ sessionsDir: f.root, out, incremental: true, withText: true })
        assert.equal(next.ftsAppended, 1, 'the receipt exists again')
        assert.equal((await searchSessions('appended after the receipt returned', { path: out })).rows.length, 1)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a store built with NO mirror searches by SCAN, and says so', async () => {
    // The other half of the mode receipt: `search_mode` is `like`, the LIKE path answers, and the caller can tell that
    // it was a scan rather than an index -- which is what makes "no matches" readable either way.
    const f = fixture()
    const out = join(f.root, 'scan.db')
    try {
        const built = buildIndex({ sessionsDir: f.root, out, withText: true, fts: false })
        assert.equal(built.searchMode, 'like')
        assert.equal(built.ftsRows, 0)
        const found = await searchSessions('summary of the above', { path: out })
        assert.equal(found.searchMode, 'like')
        assert.equal(found.textIndexed, true)
        assert.equal(found.rows.length, 1)
        assert.equal((await metaOf(out)).search_mode, 'like')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

/**
 * A SECOND session in the same root, ordinary unless its header says otherwise.
 *
 * `fixture()` is a SUBAGENT (it names a parent and an origin); this one exists so the two can be told apart in ONE
 * store, which is the only way a filter can be tested -- a store holding only subagents passes any predicate.
 */
function sessionIn(root, id, header = {}) {
    const dir = join(root, `--tmp-${id}--`, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl'), [
        JSON.stringify({ type: 'session', version: 4, id, createdAt: 1789873194200, cwd: '/tmp/work', ...header }),
        JSON.stringify({ type: 'user/message', seq: 1, time: 1, data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'do the thing' }] } }),
    ].join('\n') + '\n')
    return dir
}

test('the store can tell a SUBAGENT run from a conversation, and `exclude` does not drop the conversations', async () => {
    // ROADMAP 14.4 item 3. Measured on the live store before this existed: 318 of 499 sessions are subagent runs, and
    // the index carried `origin` and `parent_session` without being able to filter on them.
    const root = mkdtempSync(join(tmpdir(), 'session-index-sub-'))
    const out = join(root, 'store.db')
    try {
        sessionIn(root, 'session-worker', { parentSession: 'session-man', origin: 'subagent', delegationDepth: 1 })
        sessionIn(root, 'session-man')
        buildIndex({ sessionsDir: root, out })
        const all = await listSessions({ path: out })
        assert.equal(all.length, 2, 'the default is EVERYTHING: a store that hid 64% of its rows would answer a question nobody asked')
        // THE NULL CASE IS THE WHOLE POINT: an ordinary session has `origin = NULL`, and `origin != 'subagent'` is NULL
        // for it, so a naive `!=` would return ZERO conversations from an exclude. `IS NOT` is null-safe.
        const conversations = await listSessions({ path: out, subagents: 'exclude' })
        assert.deepEqual(conversations.map((row) => row.id), ['session-man'], 'the NULL origin survives an exclude')
        const workers = await listSessions({ path: out, subagents: 'only' })
        assert.deepEqual(workers.map((row) => row.id), ['session-worker'])
        assert.equal(workers[0].origin, 'subagent')
        assert.equal(workers[0].parent_session, 'session-man', 'and fork lineage rides the row beside it')
        assert.equal(conversations[0].origin, null)
        assert.deepEqual(await subagentCounts({ path: out }), { total: 2, subagents: 1 })
    } finally { rmSync(root, { recursive: true, force: true }) }
})
