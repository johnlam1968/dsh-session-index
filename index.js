// DSH-SESSION-INDEX: a session store of our own, as its own plugin.
//
// WHAT IT IS. A derived SQLite database over DSH session logs: FTS5 search (message text, reasoning, tool results and
// tool-call arguments), title/cwd lookup, reading a session's conversation, and an INCREMENTAL rebuild. It provides a
// `localSessionIndex` SERVICE and four agent-facing tools, and it imports no dsh modules at all.
//
// WHY IT EXISTS. The harness ships its own SQLite index (`@deepseek-ai/dsh-session-query-sqlite`) and its own agent
// tools (`@deepseek-ai/dsh-tool-session-query`). Enabling that index in a live deployment made
// `api-session-controller` fail to start, and the cause was never reproduced; the deployment left it at
// `openAt: never` and this store carries the capability instead. That history is the reason this package exists and is
// written down here so a reader of it alone does not have to discover it.

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defaultIndexPath, findSessions, listSessions, metaOf, searchSessions, sessionRow, subagentCounts } from './lib/store.js'
import { refreshIndex } from './lib/refresh.js'
import { readSession } from './lib/read.js'
import { createTools } from './lib/tools.js'

const name = 'session-index'

/** The service name a consumer injects. */
export const SESSION_INDEX_SERVICE = 'localSessionIndex'

/**
 * THE HOST SERVICES THIS PLUGIN REACHES, declared rather than discovered (the audit's rule (c), `F107`): `tools` is the
 * whole of it. `test/session-index-plugin.test.js` checks this against the source rather than trusting it.
 */
export const HOST_SERVICES = ['tools']

const Config = Schema.object({
    path: Schema.string().description('The derived store. Droppable: a refresh recreates it.').default(defaultIndexPath()),
    sessionsDir: Schema.string().description('Where the harness keeps its session logs. Defaults to `$DSH_HOME/sessions`.').default(''),
    tokenizer: Schema.string().description('`trigram` (substring search, largest), `unicode61` (words), or `none` for no mirror.').default('trigram'),
})

/**
 * The capability, as an object a plugin can call.
 *
 * EXACTLY WHAT A CALLER NEEDS, AND NOTHING ABOUT HOW IT IS STORED: no SQL, no table names and no file layout cross this
 * boundary, so a consumer cannot come to depend on a schema that is free to change because the store is derived.
 */
export function createSessionIndex({ path = defaultIndexPath(), sessionsDir = undefined, tokenizer = 'trigram' } = {}) {
    const options = sessionsDir === '' || sessionsDir === undefined ? {} : { sessionsDir }
    return {
        path,
        search: (term, { limit = 20 } = {}) => searchSessions(term, { path, limit }),
        find: (term, { limit = 20 } = {}) => findSessions(term, { path, limit }),
        list: ({ cwd = null, search = null, subagents = 'include', limit = 20 } = {}) => listSessions({ path, cwd, search, subagents, limit }),
        read: (id, options = {}) => readSession(id, { path, ...options }),
        row: (id) => sessionRow(id, { path }),
        meta: () => metaOf(path),
        // HOW MANY OF THE ROWS ARE SUBAGENT RUNS, so a list can say what it is a list of (ROADMAP §14.4 item 3).
        counts: () => subagentCounts({ path }),
        refresh: ({ timeoutMs = 120000 } = {}) => refreshIndex({ out: path, ...options, timeoutMs }),
        // THE BUILDER IS IMPORTED LAZILY: `lib/build.js` loads `node:sqlite` at module scope, and loading an experimental
        // built-in while a host starts should not be a plugin's side effect.
        build: async ({ withText = true, incremental = false, tokenizer: wanted = tokenizer } = {}) => {
            const { buildIndex } = await import('./lib/build.js')
            return buildIndex({ out: path, withText, incremental, tokenizer: wanted, ...options })
        },
    }
}

/**
 * THE SERVICE, IN THE DOCUMENTED FORM.
 *
 * A compliance audit (`docs/findings.md`, F107) measured the consequence of providing it as a plain object: it is
 * reachable by injection, and it does NOT appear in the live Service catalogue -- `listService` answers "no catalogued
 * Service named localSessionIndex" -- where the harness's own services (`sessionQuery`, `sessionController`) do. The
 * class form is what the contract asks for (`services-events.md` 2.1): a `Service` subclass whose constructor names the
 * key, so `ctx.localSessionIndex` is a registered service rather than an anonymous value.
 *
 * THE IMPLEMENTATION IS UNCHANGED, and `createSessionIndex` stays: the same factory a test can call directly, with the
 * class delegating to it, so the catalogue entry costs nothing in behaviour.
 */
export class LocalSessionIndex extends Service {
    constructor(ctx, config = {}) {
        super(ctx, SESSION_INDEX_SERVICE)
        Object.assign(this, createSessionIndex({
            path: config?.path ?? defaultIndexPath(),
            sessionsDir: config?.sessionsDir ?? undefined,
            tokenizer: config?.tokenizer ?? 'trigram',
        }))
    }
}

function apply(ctx, config) {
    // MOUNTED, NOT PROVIDED: `ctx.plugin` runs the class's constructor, which registers the service under its key.
    ctx.plugin(LocalSessionIndex, { ...(config ?? {}) })
    // THE TOOLS ARE THE SAME CAPABILITY, for a model -- and they read the LIVE service, so a row that is replaced (or
    // never mounts) is not answered by a stale reference.
    const live = {
        get path() { return ctx.get(SESSION_INDEX_SERVICE)?.path },
    }
    for (const method of ['search', 'find', 'list', 'read', 'row', 'meta', 'counts', 'refresh', 'build']) {
        live[method] = (...args) => ctx.get(SESSION_INDEX_SERVICE)?.[method](...args)
    }
    ctx.inject(['tools'], (child) => {
        if (child.tools === undefined || typeof child.tools.register !== 'function') return
        for (const defined of createTools({ service: live })) child.tools.register(defined)
    })
}

export { name, Config, apply }
