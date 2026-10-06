// THE HAND-ROLLED SESSION INDEX, READ SIDE -- one home for the store's path, its tables and its queries.
//
// WHY IT EXISTS. The harness ships its own SQLite FTS index (`@deepseek-ai/dsh-session-query-sqlite`), and this
// deployment leaves it at `openAt: never`; enabling it in the profile made `api-session-controller` fail to start and
// the cause was never reproduced (`F98`). So the capability lives here, in a store this repository owns:
// `scripts/session-index.mjs` BUILDS it, and this module READS it -- used by that script's CLI and by
// `lib/sessions-tool.js`, so neither can drift from the other about a path, a column or a query.
//
// `node:sqlite` IS IMPORTED LAZILY, on the first read and never at module load. It is an experimental built-in that
// prints a warning when it loads, and the plugin's own startup must not carry a warning for a store that may not
// exist. That also keeps every function here usable in a process where the store is absent: each returns a NAMED
// problem instead of throwing.
//
// WHAT A SEARCH COVERS, and the list is not just messages: message text, reasoning, tool-call ARGUMENTS and tool
// RESULTS. The harness's own extractor covers tool traffic, and a search that read only messages answered "no
// matches" for a phrase that was sitting in a tool result -- measured while writing it.

import { homedir } from 'node:os'
import { join } from 'node:path'

/** The harness home this store lives beside: `$DSH_HOME`, or `~/.dsh`. */
export function dshHome(env = process.env) {
    return env.DSH_HOME === undefined || env.DSH_HOME === '' ? join(homedir(), '.dsh') : env.DSH_HOME
}

/** The derived store `scripts/session-index.mjs` builds. Droppable: that script recreates it. */
export function defaultIndexPath(env = process.env) {
    return join(dshHome(env), 'session-index.db')
}

async function openStore(path) {
    const { DatabaseSync } = await import('node:sqlite')
    return new DatabaseSync(path, { readOnly: true })
}

/** What the store says about itself: `text_indexed`, `built_at`, `sessions`. Empty when it cannot be read. */
export async function metaOf(path = defaultIndexPath()) {
    let db
    try {
        db = await openStore(path)
        const meta = {}
        for (const row of db.prepare('SELECT key, value FROM meta').all()) meta[row.key] = row.value
        return meta
    } catch {
        return {}
    } finally {
        try { db?.close() } catch { /* a store that never opened has nothing to close */ }
    }
}

/** Sessions whose TITLE, id or working directory matches. */
export async function findSessions(term, { path = defaultIndexPath(), limit = 20 } = {}) {
    const db = await openStore(path)
    try {
        const like = `%${String(term)}%`
        return db.prepare(`
          SELECT id, title, title_source, cwd, created_at, asks, messages, tool_calls, has_title
          FROM sessions
          WHERE title LIKE ? OR cwd LIKE ? OR id LIKE ?
          ORDER BY (title LIKE ?) DESC, created_at DESC
          LIMIT ?`).all(like, like, `${String(term)}%`, like, limit)
    } finally {
        db.close()
    }
}

/**
 * A phrase, quoted for FTS5 -- and the escaping is OURS because we are the ones building query syntax.
 *
 * The harness's own search promises the query is "interpreted as data, never executable FTS syntax"; handing a caller's
 * words to `MATCH` unquoted would make `civil AND disorder` a boolean expression and `*` a prefix operator. Quoting it
 * as one phrase means exactly those words, in order.
 */
function ftsPhrase(term) {
    return '"' + String(term).replace(/"/g, '""') + '"'
}

/**
 * The mirror's own query -- IN TWO STATEMENTS, and the split is measured, not stylistic.
 *
 * `snippet()` is an FTS5 auxiliary function and SQLite refuses it in an aggregate context: the single-statement
 * version threw **"unable to use function snippet in the requested context"** here, and the failure was invisible
 * because a query FTS5 cannot parse falls back to the scan. `snippet()` WITH a join and without `GROUP BY` is fine,
 * so the counts are grouped and the snippet is fetched per matched session.
 */
/**
 * THE SNIPPET WINDOW IS COUNTED IN THE TOKENIZER'S OWN TOKENS, and that unit is not the same size in both: 12 tokens is
 * roughly 70 characters under a word tokenizer and about **14 characters** under trigram. Measured: at 12 trigram
 * tokens the window was `" ... mary of the ab ... "` -- too narrow even for the match markers -- and at 24 it was
 * `"[summary of the above]"`. So the window is chosen per mechanism, and the trigram figure approximates the scan's
 * 160-character window.
 */
const SNIPPET_TOKENS = { fts5: 12, 'fts5-trigram': 53 }

async function ftsHits(db, term, limit, mode = 'fts5') {
    const phrase = ftsPhrase(term)
    const window = SNIPPET_TOKENS[mode] ?? 12
    const rows = db.prepare(`
      SELECT s.id, s.title, s.cwd, s.created_at, COUNT(*) AS hits,
             GROUP_CONCAT(DISTINCT search_fts.source) AS sources
      FROM search_fts JOIN sessions s ON s.id = search_fts.session_id
      WHERE search_fts MATCH ?
      GROUP BY s.id ORDER BY hits DESC, s.created_at DESC LIMIT ?`).all(phrase, limit)
    const snippetFor = db.prepare(`
      SELECT snippet(search_fts, 0, '[', ']', ' ... ', ${window}) AS snippet
      FROM search_fts JOIN sessions s ON s.id = search_fts.session_id
      WHERE search_fts MATCH ? AND s.id = ? LIMIT 1`)
    return rows.map((row) => ({
        id: row.id,
        title: row.title,
        cwd: row.cwd,
        created_at: row.created_at,
        hits: row.hits,
        sources: String(row.sources ?? '').split(',').filter((source) => source !== ''),
        snippet: snippetFor.get(phrase, row.id)?.snippet ?? '',
    }))
}

/** The SCAN: every source, substring matching with `LIKE`, and a window around the first match. */
async function likeHits(db, term, limit) {
    const like = `%${String(term)}%`
    const snippet = (column) => `MIN(substr(COALESCE(${column},''), max(1, instr(lower(COALESCE(${column},'')), lower(?)) - 60), 160))`
    const queries = [
        ['text', `SELECT s.id, s.title, s.cwd, s.created_at, COUNT(*) AS hits, ${snippet('m.text')} AS snippet
                  FROM sessions s JOIN messages m ON m.session_id = s.id WHERE m.text LIKE ? GROUP BY s.id`],
        ['reasoning', `SELECT s.id, s.title, s.cwd, s.created_at, COUNT(*) AS hits, ${snippet('m.reasoning')} AS snippet
                  FROM sessions s JOIN messages m ON m.session_id = s.id WHERE m.reasoning LIKE ? GROUP BY s.id`],
        ['tool-result', `SELECT s.id, s.title, s.cwd, s.created_at, COUNT(*) AS hits, ${snippet('t.text')} AS snippet
                  FROM sessions s JOIN tool_results t ON t.session_id = s.id WHERE t.text LIKE ? GROUP BY s.id`],
        ['tool-call', `SELECT s.id, s.title, s.cwd, s.created_at, COUNT(*) AS hits, ${snippet('c.args')} AS snippet
                  FROM sessions s JOIN tool_calls c ON c.session_id = s.id WHERE c.args LIKE ? GROUP BY s.id`],
    ]
    const byId = new Map()
    for (const [source, sql] of queries) {
        let rows = []
        // A STORE FROM AN OLDER BUILD MAY LACK A TABLE, and that is a smaller failure than answering nothing: the
        // sources that exist still answer, and the caller is told which store it read.
        try { rows = db.prepare(`${sql} ORDER BY hits DESC LIMIT ?`).all(String(term), like, limit) } catch { rows = [] }
        for (const row of rows) {
            const held = byId.get(row.id) ?? { id: row.id, title: row.title, cwd: row.cwd, created_at: row.created_at, hits: 0, sources: [], snippet: '' }
            held.hits += row.hits
            held.sources.push(source)
            if (held.snippet === '' && typeof row.snippet === 'string' && row.snippet !== '') held.snippet = row.snippet
            byId.set(row.id, held)
        }
    }
    return [...byId.values()].sort((a, b) => b.hits - a.hits || (b.created_at ?? 0) - (a.created_at ?? 0))
}

/**
 * WHICH MECHANISM ANSWERS, and the caller is always told which one ran.
 *
 * Three, because a query means different things to each:
 *   `fts5-trigram`  MATCH does SUBSTRING matching -- the LIKE question, with an index (trigram tokenization);
 *   `fts5`          MATCH does token/phrase matching -- smaller, but a different question (`F99`);
 *   `like`          the scan, used when the store has no mirror, and for the queries a mirror cannot answer.
 *
 * Two kinds of query fall back to the scan rather than answer a confident zero: a PHRASE FTS5 cannot parse
 * (punctuation only), and -- for a trigram mirror -- anything SHORTER THAN THREE CHARACTERS, because three is the
 * smallest run a trigram index stores.
 */
async function textHits(db, term, limit, mode = 'like') {
    if (mode === 'fts5-trigram' && String(term).length < 3) return { rows: await likeHits(db, term, limit), mode: 'like' }
    if (mode === 'fts5' || mode === 'fts5-trigram') {
        try { return { rows: await ftsHits(db, term, limit, mode), mode } } catch { /* falls through to the scan */ }
    }
    return { rows: await likeHits(db, term, limit), mode: 'like' }
}

/**
 * TEXT SEARCH over the local store, and title/cwd/id matching, in one answer.
 *
 * `textIndexed` is reported rather than assumed: a store built without `--text` holds no message text at all, and
 * answering as though it had searched the text would read as "the phrase is not in the library".
 */
export async function searchSessions(term, { path = defaultIndexPath(), limit = 20 } = {}) {
    const meta = await metaOf(path)
    const textIndexed = meta.text_indexed === '1'
    const rows = new Map()
    for (const row of await findSessions(term, { path, limit })) {
        rows.set(row.id, { id: row.id, title: row.title, cwd: row.cwd, createdAt: row.created_at, hits: 0, matchedIn: 'title/cwd/id' })
    }
    let searchMode = 'like'
    if (textIndexed) {
        const db = await openStore(path)
        let found = { rows: [], mode: 'like' }
        const wanted = meta.search_mode !== 'fts5' ? 'like' : (meta.tokenizer === 'trigram' ? 'fts5-trigram' : 'fts5')
        try { found = await textHits(db, term, limit, wanted) } finally { db.close() }
        searchMode = found.mode
        for (const hit of found.rows) {
            const held = rows.get(hit.id)
            if (held === undefined) {
                rows.set(hit.id, { id: hit.id, title: hit.title, cwd: hit.cwd, createdAt: hit.created_at, hits: hit.hits, matchedIn: hit.sources.join('+'), snippet: hit.snippet ?? '' })
            } else {
                held.hits = hit.hits
                held.matchedIn = `${held.matchedIn}+${hit.sources.join('+')}`
                if (hit.snippet !== '') held.snippet = hit.snippet
            }
        }
    }
    const ordered = [...rows.values()].sort((a, b) => b.hits - a.hits || (b.createdAt ?? 0) - (a.createdAt ?? 0))
    return { term: String(term), textIndexed, rows: ordered.slice(0, limit), total: ordered.length, path, searchMode }
}

/**
 * The same search, shaped for a caller that must NOT throw and must say what happened.
 *
 * @returns `{ rows, textIndexed, problem }` -- `problem` names why nothing could be answered, and is absent when the
 *          store answered. An empty `rows` with a `problem` means "not asked"; an empty `rows` without one means
 *          "asked, and the phrase is not there". Those two are never allowed to look alike.
 */
export async function searchLocalIndex(term, { path = defaultIndexPath(), limit = 20 } = {}) {
    try {
        const found = await searchSessions(term, { path, limit })
        const rows = found.rows.map((row) => {
            const shaped = { id: row.id, hits: row.hits, matchedIn: row.matchedIn }
            if (row.title !== null && row.title !== undefined) shaped.title = String(row.title)
            if (row.cwd !== null && row.cwd !== undefined) shaped.cwd = String(row.cwd)
            if (typeof row.createdAt === 'number') shaped.createdAt = row.createdAt
            if (typeof row.snippet === 'string' && row.snippet !== '') shaped.snippet = row.snippet
            return shaped
        })
        return { rows, textIndexed: found.textIndexed, total: found.total, path, searchMode: found.searchMode }
    } catch (error) {
        return {
            rows: [],
            textIndexed: false,
            total: 0,
            path,
            problem: `no readable session index at ${path} (${error instanceof Error ? error.message : String(error)})`
                + ' -- build it with `node scripts/session-index.mjs build --text`',
        }
    }
}

/** One session row, or null. What `read` needs to find the file behind an id. */
export async function sessionRow(id, { path = defaultIndexPath() } = {}) {
    let db
    try {
        db = await openStore(path)
        return db.prepare('SELECT id, path, cwd, created_at, title, has_title, mtime, bytes FROM sessions WHERE id = ?').get(String(id)) ?? null
    } catch {
        return null
    } finally {
        try { db?.close() } catch { /* a store that never opened has nothing to close */ }
    }
}

/**
 * Sessions whose TITLE, id or working directory matches, newest first.
 *
 * IT LISTS WHAT THE INDEX HOLDS, which is what the last build saw -- a session still being written is only as current
 * as that build, so `refresh` is the way to close the gap. That is a fact about a store, not about a measurement, which
 * is why it belongs here and the OBSERVE allow-list does not.
 */
export async function listSessions({ path = defaultIndexPath(), cwd = null, search = null, subagents = 'include', limit = 20 } = {}) {
    const db = await openStore(path)
    try {
        const clauses = []
        const args = []
        if (cwd !== null) { clauses.push('cwd = ?'); args.push(String(cwd)) }
        if (search !== null) {
            clauses.push('(title LIKE ? OR cwd LIKE ? OR id LIKE ?)')
            const like = `%${String(search)}%`
            args.push(like, like, `${String(search)}%`)
        }
        // THE SUBAGENT DISTINCTION, which the store has always CARRIED and could not filter on (ROADMAP §14.4 item 3).
        // `origin = 'subagent'` is the harness's own classification (`SessionHeader.origin`, `types.ts:112-117`:
        // "coarse product classification for a session created as a subagent child"). `parent_session` is NOT that:
        // the same type documents it as "the session this one was forked from (seed lineage)", which is why the two
        // counts differ by one (318 vs 319) on the live store and only one of them answers "is this a worker".
        // Measured on the live store 2026-10-05: of 499 sessions, `origin = 'subagent'` for **318** and NULL for 181 --
        // so 64% of a session list is worker runs, which is the noise the operator named.
        //
        // `IS` / `IS NOT`, NOT `=`: `origin` is NULL for every ordinary session, and `origin != 'subagent'` is NULL
        // for those -- SQL three-valued logic would DROP the 181 ordinary sessions from an `exclude`, which is the
        // opposite of what the caller asked for. `IS NOT` is null-safe and keeps them.
        //
        // THE DEFAULT IS `include`, deliberately: this is a MIRROR of what was built, and a store that silently hid
        // 64% of its rows would be answering a different question than the one it was asked. The filter is opt-in and
        // named, and the tool reports the count either way.
        if (subagents === 'exclude') clauses.push("origin IS NOT 'subagent'")
        else if (subagents === 'only') clauses.push("origin IS 'subagent'")
        const where = clauses.length === 0 ? '' : ' WHERE ' + clauses.join(' AND ')
        return db.prepare(`SELECT id, title, cwd, created_at, has_title, mtime, bytes, events, messages, asks, tool_calls,
            origin, parent_session
            FROM sessions${where} ORDER BY created_at DESC LIMIT ?`).all(...args, limit)
    } finally {
        db.close()
    }
}

/**
 * How many sessions the store holds, and how many of them are subagent runs.
 *
 * SO A LIST CAN SAY WHAT IT IS A LIST OF. `sessions` is the same total `metaOf` reports; `subagents` is the count the
 * `subagents: 'exclude'` filter would remove, and it exists because a reader looking at 20 rows cannot tell whether
 * the store behind them holds 20 or 499.
 */
export async function subagentCounts({ path = defaultIndexPath() } = {}) {
    const db = await openStore(path)
    try {
        const row = db.prepare(`SELECT count(*) AS total, sum(CASE WHEN origin IS 'subagent' THEN 1 ELSE 0 END) AS subagents FROM sessions`).get()
        return { total: Number(row?.total ?? 0), subagents: Number(row?.subagents ?? 0) }
    } finally {
        db.close()
    }
}
