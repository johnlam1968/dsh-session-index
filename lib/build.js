// THE SESSION INDEX -- a DERIVED, DROPPABLE store over the harness's own session logs.
//
// WHY IT EXISTS. `sessionQuery` can enumerate sessions and read a title per id, but it cannot SEARCH a title, and the
// cost of asking it is the whole library: measured on this host, 505 session files totalling 191 MB, with the largest
// at 32 MB. A `listSessions()` plus a title read per session is a scan of all of it to answer "which session is called
// X", and a live call was aborted mid-flight rather than answering.
//
// WHAT IT IS NOT. It is not a source of truth, and it is not consulted by anything in the live path. The log is the
// evidence; this is a projection of it, rebuildable from scratch, and every row carries the facts that make that
// checkable (the file it came from, its size, the seq it was read to). Delete the file and nothing is lost.
//
// IT READS WHAT THE PLUGIN ALREADY READS. `lib/host/session-format.js` owns the harness's vocabulary -- the event
// names, the two message shapes, which block kinds are text -- and this script is the second consumer of that same
// knowledge rather than a second opinion about it.
//
// IT IS THE HAND-ROLLED ANSWER TO SESSION SEARCH, and it is the one in use. The harness ships its own SQLite FTS
// index (`@deepseek-ai/dsh-session-query-sqlite`), which this profile had configured `openAt: never`; enabling it
// there made `api-session-controller` fail to start, and the cause was never reproduced (a probe of the same profile
// with the same override on another port booted cleanly). See `F98`. So the native route is left at its deployment
// default and this store keeps the capability.
//
// Usage:
//   node scripts/session-index.mjs build  [--out FILE] [--sessions DIR] [--text] [--incremental] [--no-fts]
//                                         [--tokenizer trigram|unicode61]
//   node scripts/session-index.mjs find   <term> [--out FILE] [--limit N]
//   node scripts/session-index.mjs search <phrase> [--out FILE] [--limit N]
//   node scripts/session-index.mjs stats  [--out FILE]

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultIndexPath, findSessions, metaOf, searchSessions } from './store.js'

/** Where the harness keeps its sessions, unless told otherwise. */
export const DEFAULT_SESSIONS_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
/** The derived store, resolved by the read side so both callers agree on one path. */
export const DEFAULT_INDEX = defaultIndexPath()

/**
 * THE STORE'S OWN VERSION, because a receipt is not enough.
 *
 * `mtime`+`bytes` says "this FILE did not change", which is true and useless when the SCHEMA changed: the first
 * incremental run after a column was added skipped all 498 sessions and left the new column empty everywhere, which
 * looks exactly like a store with nothing to say. So the version is stored in the file (`PRAGMA user_version`) and a
 * mismatch throws the receipts away.
 */
export const SCHEMA_VERSION = 4

const tokenizerOf = (value) => (value === 'trigram' ? 'trigram' : 'unicode61')

const SCHEMA = (tokenizer = 'trigram') => `
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, path TEXT NOT NULL, format TEXT, cwd TEXT, created_at INTEGER,
  title TEXT, title_source TEXT, title_seqs TEXT, has_title INTEGER NOT NULL DEFAULT 0,
  explicit_rename INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0, messages INTEGER NOT NULL DEFAULT 0,
  asks INTEGER NOT NULL DEFAULT 0, assistant INTEGER NOT NULL DEFAULT 0,
  reasoning_chars INTEGER NOT NULL DEFAULT 0, visible_chars INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0, shadowed INTEGER NOT NULL DEFAULT 0,
  high_water INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
  source_sha256 TEXT, indexed_at TEXT NOT NULL, mtime REAL,
  -- THE DECLARED HEADER FIELDS THE FIRST VERSION OF THIS SCHEMA MISSED. All five are in HeaderLine
  -- (session-persistence-jsonl/lib/types/format.d.ts), which states the first JSONL record exactly: a derived schema
  -- that reads one real file finds cwd and createdAt and never learns that a session can name its PARENT, say it
  -- is a SUBAGENT's, or say how deep the delegation goes.
  parent_session TEXT, origin TEXT, delegation_depth INTEGER, agent_preset TEXT, is_seeded INTEGER
);
CREATE TABLE IF NOT EXISTS messages(
  session_id TEXT NOT NULL, seq INTEGER, turn INTEGER, role TEXT, kind TEXT,
  text TEXT, reasoning TEXT, shadowed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tool_calls(session_id TEXT NOT NULL, call_id TEXT, name TEXT, args TEXT, seq INTEGER);
CREATE INDEX IF NOT EXISTS calls_by_session ON tool_calls(session_id);
-- WHAT THIS STORE ACTUALLY HOLDS. 'text_indexed' is a MODE receipt: a build without text and a build with it are
-- different stores, and searching the second as if it were the first would report "no matches" for text that was
-- never stored. Same rule as the schema version: a receipt must cover the mode, not only the file.
-- (NO BACKTICKS IN THIS BLOCK: the schema is a JavaScript template literal, and a backtick in a SQL comment ends it.
-- Cost two syntax errors to learn.)
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
-- THE FTS5 MIRROR OF EVERY SEARCHABLE ROW. Not a second store: it is derived from messages, tool_results and
-- tool_calls, so it can be rebuilt from them without re-reading a single session file. It exists because a LIKE scan
-- answers in ~200 ms at 155 MB and FTS5 asks the same question through an inverted index.
-- THE TOKENIZER DECIDES WHAT A QUERY MEANS, so it is recorded in meta and chosen deliberately:
--   'trigram'    indexes every overlapping 3-character run, so MATCH does SUBSTRING matching -- the same question the
--                LIKE scan answered, at the cost of an index several times the size of the text;
--   'unicode61'  indexes WORDS, so MATCH does token and phrase matching -- smaller, but "ervo" and "voice-prox" find
--                nothing, which is a DIFFERENT question from the one the scan answered (F99).
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(body, session_id UNINDEXED, source UNINDEXED, seq UNINDEXED, tokenize = '${tokenizer}');
-- HOW FAR EACH SESSION'S MIRROR HAS BEEN BUILT. The receipt that makes maintenance APPEND rather than replace: a DSH
-- log only ever grows, so the mirror rows for seq <= high_water are already there and their content cannot have
-- changed. Measured before this existed: maintaining ONE 15,037-row session cost a 4,087 ms delete + 4,413 ms insert,
-- and a rowid map would have saved 92 ms of it (F106) -- the work itself had to go, not the lookup.
CREATE TABLE IF NOT EXISTS mirror_state(session_id TEXT PRIMARY KEY, high_water INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tool_results(session_id TEXT NOT NULL, call_id TEXT, text TEXT, chars INTEGER NOT NULL DEFAULT 0, is_error INTEGER NOT NULL DEFAULT 0, seq INTEGER);
CREATE INDEX IF NOT EXISTS results_by_session ON tool_results(session_id);
CREATE INDEX IF NOT EXISTS messages_by_session ON messages(session_id);
`

/**
 * Every `.jsonl` and `.jsonl.zstd` session file under `dir`, one per session.
 *
 * The harness keeps a session in more than one format version while a migration is being carried (`session.v3` and
 * `session.v4` for the same id), so the CURRENT writer wins and the older file is skipped rather than counted twice.
 */
export function sessionFiles(dir = DEFAULT_SESSIONS_DIR) {
    const bySession = new Map()
    const walk = (current) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const full = join(current, entry.name)
            if (entry.isDirectory()) { walk(full); continue }
            if (!/^session\.v\d+\.jsonl(\.zstd)?$/.test(entry.name)) continue
            const version = Number(/^session\.v(\d+)/.exec(entry.name)[1])
            const id = current.split('/').pop()
            const held = bySession.get(id)
            if (held === undefined || version > held.version) bySession.set(id, { id, path: full, version })
        }
    }
    walk(dir)
    return [...bySession.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** The decoded lines of one session file. `.zstd` is the harness's own, multi-frame, so `zstd -dc` reads it. */
export function sessionLines(path) {
    if (path.endsWith('.zstd')) {
        const done = spawnSync('zstd', ['-dc', path], { maxBuffer: 1 << 30 })
        if (done.status !== 0) throw new Error(`zstd failed on ${path}: ${String(done.stderr).slice(0, 200)}`)
        return { text: done.stdout.toString('utf8'), sha256: createHash('sha256').update(done.stdout).digest('hex').slice(0, 16) }
    }
    const buf = readFileSync(path)
    return { text: buf.toString('utf8'), sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16) }
}

export const blockText = (content, kinds) => {
    // AN UNTYPED STRING IS TEXT, NEVER REASONING. Only a typed block can be reasoning, so a string body must not be
    // counted as both -- which is what happened first, and a fixture caught it: 25 reasoning characters for a 5-char
    // reasoning block, because the 20-char injected summary was added to BOTH counters.
    if (typeof content === 'string') return kinds.includes('text') ? content : ''
    if (!Array.isArray(content)) return ''
    return content.filter((b) => b !== null && typeof b === 'object' && kinds.includes(b.type))
        .map((b) => b.text ?? b.thinking ?? '').join('')
}

/** One row per session, folded from its own events. Pure; never throws. */
export function foldSession({ id, path, version, text, sha256, bytes }) {
    const row = {
        id, path, format: `v${version}`, cwd: null, created_at: null,
        title: null, title_source: null, title_seqs: null, has_title: 0, explicit_rename: 0,
        events: 0, messages: 0, asks: 0, assistant: 0, reasoning_chars: 0, visible_chars: 0,
        tool_calls: 0, shadowed: 0, high_water: 0, bytes, source_sha256: sha256,
        parent_session: null, origin: null, delegation_depth: null, agent_preset: null, is_seeded: null,
    }
    const messages = []
    const calls = []
    const results = []
    const replaced = []
    for (const line of text.split('\n')) {
        if (line === '') continue
        let event
        try { event = JSON.parse(line) } catch { continue }
        row.events += 1
        const data = event.data ?? {}
        if (typeof event.seq === 'number') row.high_water = Math.max(row.high_water, event.seq)
        const op = event.surfaceOp
        if (op !== null && typeof op === 'object' && op.op === 'replace'
            && typeof op.startSeq === 'number' && typeof op.endSeq === 'number') replaced.push([op.startSeq, op.endSeq])
        // THE HEADER IS A RECORD, NOT A `data` PAYLOAD. The first line of a dsh log is
        // `{"type":"session","version":4,"id":…,"createdAt":…,"cwd":"/home/john/…"}` -- `cwd` and `createdAt` sit at the
        // TOP LEVEL, which is the same shape pi writes. Reading only `data.cwd` indexed 0 of 498 sessions with a cwd.
        if (event.type === 'session') {
            if (typeof event.cwd === 'string') row.cwd = event.cwd
            if (typeof event.createdAt === 'number') row.created_at = event.createdAt
            if (typeof event.version === 'number') row.format = `v${event.version}`
            if (typeof event.parentSession === 'string') row.parent_session = event.parentSession
            if (typeof event.origin === 'string') row.origin = event.origin
            if (typeof event.delegationDepth === 'number') row.delegation_depth = event.delegationDepth
            if (typeof event.agentPreset === 'string') row.agent_preset = event.agentPreset
            row.is_seeded = event.isSeeded === true ? 1 : 0
            continue
        }
        if (row.cwd === null && typeof data.cwd === 'string') row.cwd = data.cwd
        if (row.created_at === null && typeof event.time === 'number') row.created_at = event.time

        // THE TITLE IS AN EVENT (`session/title`), declared by the harness's session-title package. Its `source` says
        // whether the model, a fallback, or the operator produced it -- and `messageSeqs` names the asks it came from.
        if (event.type === 'session/title') {
            if (typeof data.title === 'string' && data.title !== '') {
                row.title = data.title
                // `source` IS AN OBJECT on a real log: `{kind:'provider', provider:'session-title-first-prompt-llm',
                // model:{…}}` or `{kind:'fallback'}`, and only `{kind:'user'}` is a rename. Storing it only when it was
                // a string lost every real title's provenance.
                row.title_source = typeof data.source === 'string' ? data.source : JSON.stringify(data.source ?? null)
                row.title_seqs = JSON.stringify(data.messageSeqs ?? [])
                row.has_title = 1
                row.explicit_rename = (data.source?.kind ?? data.source) === 'user' ? 1 : 0
            }
            continue
        }
        if (event.type === 'session/header' && typeof data.cwd === 'string') row.cwd = data.cwd
        if (event.type === 'tool/call') {
            row.tool_calls += 1
            calls.push([id, String(data.callId ?? ''), String(data.name ?? ''), String(data.arguments ?? '').slice(0, 4000), typeof event.seq === 'number' ? event.seq : null])
            continue
        }
        // A RESULT'S ID LIVES IN TWO PLACES and both are read here -- `message.toolCallId` and `message.source.callId`.
        // `lib/tool-blocks.js` documents the same rule for the composer, and pairing on one place alone is what left
        // results matched by position there.
        if (event.type === 'tool/result') {
            const message = data.message ?? {}
            const callId = String(data.callId ?? data.toolCallId ?? message.toolCallId ?? (message.source ?? {}).callId ?? '')
            const content = message.content
            const text = typeof content === 'string' ? content
                : Array.isArray(content) ? content.filter((b) => b !== null && typeof b === 'object' && b.type === 'text').map((b) => b.text ?? '').join('') : ''
            // THE CAP IS THE COMPOSER'S OWN ORDER OF MAGNITUDE, and the FULL LENGTH is stored beside it: a truncated
            // result with no length reads as a short result, which is the failure `lib/tool-blocks.js` exists to avoid.
            results.push([id, callId, text.slice(0, 8000), text.length, data.error === undefined && message.isError !== true ? 0 : 1, typeof event.seq === 'number' ? event.seq : null])
            continue
        }
        if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
        row.messages += 1
        const content = event.type === 'user/message' ? data.content : (data.message ?? {}).content
        const visible = blockText(content, ['text'])
        const reasoning = blockText(content, ['reasoning', 'thinking'])
        const kind = event.type === 'user/message' ? String((data.source ?? {}).kind ?? 'user') : 'assistant'
        if (event.type === 'user/message' && kind === 'user') row.asks += 1
        if (event.type === 'assistant/message') row.assistant += 1
        row.visible_chars += visible.length
        row.reasoning_chars += reasoning.length
        const seq = event.seq ?? null
        messages.push([id, seq, typeof data.turn === 'number' ? data.turn : null, kind === 'user' ? 'user' : (kind === 'assistant' ? 'assistant' : 'harness'), kind, visible, reasoning, 0])
    }
    // A REPLACEMENT WITHDRAWS EVENTS THAT CAME *BEFORE* IT -- a compaction summary arrives after the span it replaces --
    // so the shadowed flag cannot be decided while walking forward: every event of a replaced range has already been
    // counted by the time the range is known. Measured on this host: deciding inline reported 0 shadowed messages
    // across 498 sessions, where the session this was written in alone holds 3,417.
    for (const message of messages) {
        if (typeof message[1] === 'number' && replaced.some(([a, b]) => message[1] >= a && message[1] <= b)) {
            message[7] = 1
            row.shadowed += 1
        }
    }
    return { row, messages, calls, results }
}

/** Build the index. Returns what it wrote, so a caller can print it rather than assume it. */
export function buildIndex({ sessionsDir = DEFAULT_SESSIONS_DIR, out = DEFAULT_INDEX, withText = false, incremental = false, fts = true, tokenizer = 'trigram', onProgress = null } = {}) {
    const db = new DatabaseSync(out)
    db.exec('PRAGMA journal_mode = WAL;')
    // A DERIVED STORE MIGRATES BY BEING THROWN AWAY. `CREATE TABLE IF NOT EXISTS` cannot add a column -- measured here,
    // the first attempt failed with "table tool_results has no column named chars" -- and an ALTER per column would be
    // maintenance for data nobody owns. The version is read BEFORE the schema runs, and a mismatch drops the tables.
    const heldVersion = db.prepare('PRAGMA user_version').get().user_version
    const schemaMoved = heldVersion !== SCHEMA_VERSION
    if (schemaMoved) {
        db.exec('DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS tool_calls; '
            + 'DROP TABLE IF EXISTS tool_results; DROP TABLE IF EXISTS titles_fts; DROP TABLE IF EXISTS meta; '
            + 'DROP TABLE IF EXISTS mirror_state; '
            + 'DROP TABLE IF EXISTS search_fts;')
    }
    const wantFts = fts && withText
    const wantTokenizer = tokenizerOf(tokenizer)
    // A VIRTUAL TABLE'S TOKENIZER CANNOT BE ALTERED, so changing it means dropping the mirror. That is a rebuild of the
    // MIRROR ONLY: every searchable row is in messages/tool_results/tool_calls, so no session file is read again.
    //
    // THE TOKENIZER IS READ FROM THE TABLE, NOT FROM meta, and the difference is measured: `meta` is a RECEIPT, and a
    // store built before that receipt existed reported `tokenizer: trigram` while the table underneath was still
    // unicode61 -- so the drop was skipped and the search quietly kept word semantics (`voice` matched 3293 rows,
    // `oice` matched none). A receipt can be absent or stale; `sqlite_master` is the table.
    const heldTokenizer = (() => {
        try {
            const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'search_fts'").get()
            if (row?.sql === undefined) return ''
            const stated = /tokenize\s*=\s*'([^']+)'/.exec(String(row.sql))
            return stated === null ? 'unicode61' : stated[1]
        } catch { return '' }
    })()
    if (heldTokenizer !== '' && heldTokenizer !== wantTokenizer) db.exec('DROP TABLE IF EXISTS search_fts')
    db.exec(SCHEMA(wantTokenizer))
    const heldText = db.prepare("SELECT value FROM meta WHERE key = 'text_indexed'").get()?.value ?? ''
    const modeChanged = (heldText === '1') !== withText
    const receiptsUsable = incremental && !schemaMoved && !modeChanged
    if (!receiptsUsable) {
        db.exec('DELETE FROM sessions; DELETE FROM messages; DELETE FROM tool_calls; DELETE FROM tool_results;')
    }
    // THE MIRROR'S RECEIPT, read BEFORE anything is refolded: it says how far each session's mirror was built.
    const mirrorHigh = new Map()
    for (const held of db.prepare('SELECT session_id, high_water FROM mirror_state').all()) mirrorHigh.set(held.session_id, held.high_water)
    const newHigh = new Map()
    const known = new Map()
    if (receiptsUsable) {
        for (const held of db.prepare('SELECT id, mtime, bytes FROM sessions').all()) known.set(held.id, held)
    }
    // COLUMNS ARE NAMED, not positional: `mtime` was added to an existing store by ALTER, and a positional INSERT
    // then failed with "table sessions has 23 columns but 22 values were supplied". Naming them makes the next column
    // an addition rather than a breakage.
    const insertSession = db.prepare(`INSERT INTO sessions
      (id, path, format, cwd, created_at, title, title_source, title_seqs, has_title, explicit_rename, events,
       messages, asks, assistant, reasoning_chars, visible_chars, tool_calls, shadowed, high_water, bytes,
       source_sha256, indexed_at, mtime, parent_session, origin, delegation_depth, agent_preset, is_seeded)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const insertMessage = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)')
    const insertCall = db.prepare('INSERT INTO tool_calls VALUES (?,?,?,?,?)')
    const insertResult = db.prepare('INSERT INTO tool_results (session_id, call_id, text, chars, is_error, seq) VALUES (?,?,?,?,?,?)')
    // A SESSION IS REFOLDED WHEN ITS FILE CHANGED. Appending is the only thing the harness does to a log, and it moves
    // both mtime and size, so the pair is the receipt that makes the second build cheap.
    const dropSession = db.prepare('DELETE FROM messages WHERE session_id = ?')
    const dropCalls = db.prepare('DELETE FROM tool_calls WHERE session_id = ?')
    const dropResults = db.prepare('DELETE FROM tool_results WHERE session_id = ?')
    const files = sessionFiles(sessionsDir)
    const refoldStarted = Date.now()
    const now = new Date().toISOString()
    let done = 0
    let skipped = 0
    let ftsRebuilt0 = false
    // WHICH SESSIONS WERE REFOLDED, so the mirror can be maintained for THEM instead of rebuilt whole. Measured on this
    // library before the fix: one changed session cost refold 43.3 s + mirror 66.6 s, because 91,380 mirror rows were
    // deleted and re-inserted for 499 sessions of which exactly one had changed.
    const refoldedIds = []
    // WHERE THE REFOLD'S TIME GOES, because "make it incremental" is only worth it if the DECODE is the cost: the phases
    // are timed separately so the next change targets the measured one.
    const phase = { decodeMs: 0, foldMs: 0, insertMs: 0 }
    for (const file of files) {
        const stat = statSync(file.path)
        const held = known.get(file.id)
        if (held !== undefined && held.mtime === stat.mtimeMs && held.bytes === stat.size) { skipped += 1; continue }
        let lines
        const t0 = Date.now()
        try { lines = sessionLines(file.path) } catch { continue }
        phase.decodeMs += Date.now() - t0
        const t1 = Date.now()
        const { row, messages, calls, results } = foldSession({ ...file, text: lines.text, sha256: lines.sha256, bytes: stat.size })
        phase.foldMs += Date.now() - t1
        const t2 = Date.now()
        // ONE TRANSACTION PER SESSION, and the measurement is why: with a commit per row, the insert phase of ONE 33 MB
        // session measured **41.3 s** -- against 0.9 s to DECODE it and 0.9 s to fold it. The cost was never the log, it
        // was SQLite committing every message, call and result on its own. A session is replaced atomically here too,
        // which is what "refolding replaces a session" should mean: a reader sees the old session or the new one.
        db.exec('BEGIN')
        try {
        if (held !== undefined) {
            dropSession.run(file.id); dropCalls.run(file.id); dropResults.run(file.id)
            db.prepare('DELETE FROM sessions WHERE id = ?').run(file.id)
        }
        insertSession.run(row.id, row.path, row.format, row.cwd, row.created_at, row.title, row.title_source, row.title_seqs,
            row.has_title, row.explicit_rename, row.events, row.messages, row.asks, row.assistant, row.reasoning_chars,
            row.visible_chars, row.tool_calls, row.shadowed, row.high_water, row.bytes, row.source_sha256, now, stat.mtimeMs,
            row.parent_session, row.origin, row.delegation_depth, row.agent_preset, row.is_seeded)
        if (withText) for (const m of messages) insertMessage.run(...m)
        for (const c of calls) insertCall.run(...c)
        for (const r of results) insertResult.run(...r)
        db.exec('COMMIT')
        } catch (error) { db.exec('ROLLBACK'); throw error }
        phase.insertMs += Date.now() - t2
        newHigh.set(file.id, row.high_water)
        done += 1
        ftsRebuilt0 = true
        refoldedIds.push(file.id)
        if (onProgress !== null && done % 25 === 0) onProgress(done, files.length)
    }
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS titles_fts USING fts5(id UNINDEXED, title, cwd)')
    db.exec('DELETE FROM titles_fts')
    db.exec("INSERT INTO titles_fts(id, title, cwd) SELECT id, COALESCE(title,''), COALESCE(cwd,'') FROM sessions")
    // THE VERSION IS STAMPED LAST. Stamping it before the build marked a store that never finished as current: the next
    // run saw "same version", kept the old tables, and failed on a column that did not exist. A crash must leave the
    // version BEHIND the schema so the following run rebuilds.
    const refoldMs = Date.now() - refoldStarted
    const mirrorStarted = Date.now()
    // THE MIRROR IS REBUILT FROM THE TABLES, NOT FROM THE LOGS: every searchable row is already stored, so this costs
    // one INSERT..SELECT per source instead of decoding 499 session files again. The receipt is the row counts: if the
    // mirror and the sources disagree -- or anything was refolded, which changes the sources -- it is rebuilt.
    const searchable = db.prepare(`SELECT
        (SELECT COUNT(*) FROM messages WHERE text IS NOT NULL AND text <> '')
      + (SELECT COUNT(*) FROM messages WHERE reasoning IS NOT NULL AND reasoning <> '')
      + (SELECT COUNT(*) FROM tool_results WHERE text IS NOT NULL AND text <> '')
      + (SELECT COUNT(*) FROM tool_calls WHERE args IS NOT NULL AND args <> '') AS n`).get().n
    let ftsRows = db.prepare('SELECT COUNT(*) AS n FROM search_fts').get().n
    let ftsRebuilt = false
    let ftsMaintained = 0
    let ftsAppended = 0
    let ftsReplaced = 0
    let ftsUnchanged = 0
    const MIRROR_SOURCES = [
        ['text', 'messages', 'text', "text IS NOT NULL AND text <> ''"],
        ['reasoning', 'messages', 'reasoning', "reasoning IS NOT NULL AND reasoning <> ''"],
        ['tool-result', 'tool_results', 'text', "text IS NOT NULL AND text <> ''"],
        ['tool-call', 'tool_calls', 'args', "args IS NOT NULL AND args <> ''"],
    ]
    /** Every searchable row of a session (or of the whole store when `where` is `1 = 1`). */
    const insertFor = (where, args) => {
        for (const [source, table, column, notEmpty] of MIRROR_SOURCES) {
            db.prepare(`INSERT INTO search_fts (body, session_id, source, seq) SELECT ${column}, session_id, '${source}', seq FROM ${table} WHERE ${where} AND ${notEmpty}`).run(...args)
        }
    }
    /** ONLY WHAT THE LOG APPENDED: the rows above the high-water mark this session's mirror already holds. */
    const appendFor = (id, after) => {
        for (const [source, table, column, notEmpty] of MIRROR_SOURCES) {
            db.prepare(`INSERT INTO search_fts (body, session_id, source, seq) SELECT ${column}, session_id, '${source}', seq FROM ${table} WHERE session_id = ? AND seq IS NOT NULL AND seq > ? AND ${notEmpty}`).run(id, after)
        }
    }
    /**
     * A ROW WITH NO SEQ CANNOT BE APPENDED, because "have I mirrored it already" is unanswerable for it. A session that
     * has one is REPLACED instead -- correct rather than clever, and it costs one session's index work, not the store's.
     */
    const hasSeqless = (id) => MIRROR_SOURCES.some(([, table, column, notEmpty]) =>
        db.prepare(`SELECT 1 AS x FROM ${table} WHERE session_id = ? AND seq IS NULL AND ${notEmpty} LIMIT 1`).get(id) !== undefined)
    // THE MIRROR IS MAINTAINED PER SESSION, and rebuilt whole only when it CANNOT BE TRUSTED. The distinction matters and
    // was got wrong once: a refold necessarily changes the source count (the session gained rows), so comparing the
    // mirror's count with the sources AFTER the refold condemns exactly the case maintenance exists for. What the counts
    // can say is whether the mirror is ABSENT or was never built for this store -- and, after maintenance, whether the
    // result adds up.
    const mirrorMissing = wantFts && ftsRows === 0 && searchable > 0
    if (mirrorMissing) {
        db.exec('BEGIN')
        try { db.exec('DELETE FROM search_fts'); insertFor('1 = 1', []) ; db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error }
        ftsRebuilt = true
    } else if (wantFts && refoldedIds.length > 0) {
        db.exec('BEGIN')
        try {
            for (const id of refoldedIds) {
                const held = mirrorHigh.get(id)
                const high = newHigh.get(id) ?? 0
                if (held !== undefined && high > held && !hasSeqless(id)) {
                    appendFor(id, held)
                    ftsAppended += 1
                } else if (held !== undefined && high === held && !hasSeqless(id)) {
                    // nothing new was appended to the log, so nothing needs mirroring
                    ftsUnchanged += 1
                } else {
                    // NO RECEIPT, a log that SHRANK, or a row with no seq: replace this session's rows rather than guess
                    db.prepare('DELETE FROM search_fts WHERE session_id = ?').run(id)
                    insertFor('session_id = ?', [id])
                    ftsReplaced += 1
                }
                db.prepare('INSERT OR REPLACE INTO mirror_state (session_id, high_water) VALUES (?, ?)').run(id, high)
            }
            db.exec('COMMIT')
        } catch (error) { db.exec('ROLLBACK'); throw error }
        ftsMaintained = refoldedIds.length
        // A MAINTENANCE THAT DOES NOT ADD UP IS REBUILT WHOLE, rather than left subtly wrong: the counts are the receipt.
        if (db.prepare('SELECT COUNT(*) AS n FROM search_fts').get().n !== searchable) {
            db.exec('BEGIN')
            try { db.exec('DELETE FROM search_fts'); insertFor('1 = 1', []); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error }
            ftsRebuilt = true
            ftsMaintained = 0
        }
    } else if (wantFts && ftsRows !== searchable) {
        // NOTHING WAS REFOLDED, YET THE MIRROR DISAGREES WITH THE TABLES: a store left inconsistent by an interrupted
        // build, which the counts can still see because no session changed under it.
        db.exec('BEGIN')
        try { db.exec('DELETE FROM search_fts'); insertFor('1 = 1', []); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error }
        ftsRebuilt = true
    }
    if (ftsRebuilt) db.exec('DELETE FROM mirror_state; INSERT INTO mirror_state (session_id, high_water) SELECT id, high_water FROM sessions')
    ftsRows = db.prepare('SELECT COUNT(*) AS n FROM search_fts').get().n
    if (!wantFts && ftsRows > 0) {
        db.exec('DELETE FROM search_fts')
        ftsRows = 0
        ftsRebuilt = true
    }
    const mirrorMs = Date.now() - mirrorStarted
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    const stamp = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    stamp.run('text_indexed', withText ? '1' : '0')
    stamp.run('search_mode', wantFts ? 'fts5' : 'like')
    stamp.run('tokenizer', wantFts ? wantTokenizer : 'none')
    stamp.run('fts_rows', String(ftsRows))
    stamp.run('built_at', new Date().toISOString())
    stamp.run('sessions', String(readCounts(out).sessions))
    db.close()
    // THE SUMMARY IS READ BACK FROM THE STORE, not accumulated during the walk: in an incremental run most rows were
    // never walked, so a running counter would describe the refold rather than the index.
    const counts = readCounts(out)
    return { sessions: counts.sessions, refolded: done, skipped, schemaMoved, modeChanged, ftsRebuilt, ftsMaintained, ftsAppended, ftsReplaced, ftsUnchanged, ftsRows, refoldMs, mirrorMs, ...phase, searchMode: wantFts ? 'fts5' : 'like', tokenizer: wantFts ? wantTokenizer : 'none', titled: counts.titled, untitled: counts.sessions - counts.titled, out }
}

// THE READ SIDE LIVES IN `lib/store.js`, so this builder and the plugin's service cannot drift about a path, a column or
// a query: `findSessions`, `metaOf` and `searchSessions` are imported from there, and both callers use the same code.

/** What the store holds, read back rather than assumed from the number of files walked. */
export function readCounts(out = DEFAULT_INDEX) {
    const db = new DatabaseSync(out, { readOnly: true })
    const row = db.prepare('SELECT COUNT(*) sessions, SUM(has_title) titled, SUM(shadowed) shadowed, SUM(asks) asks FROM sessions').get()
    db.close()
    return { sessions: row.sessions, titled: row.titled ?? 0, shadowed: row.shadowed ?? 0, asks: row.asks ?? 0 }
}
