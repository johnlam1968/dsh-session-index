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

import Schema from '@deepseek-ai/schemastery'
import { defaultIndexPath, findSessions, listSessions, metaOf, searchSessions, sessionRow } from './lib/store.js'
import { refreshIndex } from './lib/refresh.js'
import { readSession } from './lib/read.js'
import { createTools } from './lib/tools.js'

const name = 'session-index'

/** The service name a consumer injects. */
export const SESSION_INDEX_SERVICE = 'localSessionIndex'

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
        list: ({ cwd = null, search = null, limit = 20 } = {}) => listSessions({ path, cwd, search, limit }),
        read: (id, options = {}) => readSession(id, { path, ...options }),
        row: (id) => sessionRow(id, { path }),
        meta: () => metaOf(path),
        refresh: ({ timeoutMs = 120000 } = {}) => refreshIndex({ out: path, ...options, timeoutMs }),
        // THE BUILDER IS IMPORTED LAZILY: `lib/build.js` loads `node:sqlite` at module scope, and loading an experimental
        // built-in while a host starts should not be a plugin's side effect.
        build: async ({ withText = true, incremental = false, tokenizer: wanted = tokenizer } = {}) => {
            const { buildIndex } = await import('./lib/build.js')
            return buildIndex({ out: path, withText, incremental, tokenizer: wanted, ...options })
        },
    }
}

function apply(ctx, config) {
    const service = createSessionIndex({
        path: config?.path ?? defaultIndexPath(),
        sessionsDir: config?.sessionsDir ?? undefined,
        tokenizer: config?.tokenizer ?? 'trigram',
    })
    // PROVIDED, NOT SET: a consumer may inject it, and one that does not is unaffected.
    ctx.provide(SESSION_INDEX_SERVICE, service)
    // THE TOOLS ARE THE SAME CAPABILITY, for a model: registered only where a tool registry exists.
    ctx.inject(['tools'], (child) => {
        if (child.tools === undefined || typeof child.tools.register !== 'function') return
        for (const defined of createTools({ service })) child.tools.register(defined)
    })
}

export { name, Config, apply }
