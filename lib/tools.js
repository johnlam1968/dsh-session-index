// THE AGENT-FACING TOOLS: what a session STORE offers a model, and nothing about measurement.
//
// FOUR QUESTIONS, ONE HOME EACH:
//   `session_index_list`     what is in the store (id, title, working directory, size in events)
//   `session_index_read`     one session's conversation, as it was said
//   `session_index_search`   where a phrase appears -- text, reasoning, tool results, tool arguments
//   `session_index_refresh`  bring the store current, incrementally, in a child process
//
// WHAT IS NOT HERE, ON PURPOSE: the observer's `read` composes the SUBJECT a judgement would see, its `list` marks the
// OBSERVE allow-list, and both are measurement semantics. A session library that carried them would be useless to a
// deployment that measures nothing, which is exactly why this package was split out.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { checkAgainst } from './args.js'

const TOOL = {
    list: 'session_index_list',
    read: 'session_index_read',
    search: 'session_index_search',
    refresh: 'session_index_refresh',
}

const PARAMETERS = {
    list: {
        type: 'object', additionalProperties: false,
        properties: {
            cwd: { type: 'string', description: 'Only sessions whose working directory equals this. The directory is the stable handle: a title is a summary of the work.' },
            search: { type: 'string', description: 'A case-insensitive substring of the title, the id or the working directory.' },
            subagents: { type: 'string', enum: ['include', 'exclude', 'only'], description: 'What to do with SUBAGENT runs, which are the majority of this store (measured: 318 of 499). `include` (the default) lists everything, `exclude` drops them, `only` keeps just them. The result always reports the total and the subagent count, so neither choice is silent.' },
            limit: { type: 'number', description: 'How many rows to return. Defaults to 20.' },
        },
    },
    read: {
        type: 'object', additionalProperties: false,
        properties: {
            sessionId: { type: 'string', description: 'The session to read. Required.' },
            kinds: { type: 'array', items: { type: 'string' }, description: 'Which roles to include: `operator`, `assistant`, or an injected source kind such as `agent-note`. Defaults to the two voices.' },
            lastMessages: { type: 'number', description: 'How many of the NEWEST messages to include. 0 (the default) is all of them.' },
            offset: { type: 'number', description: 'How many of the newest messages to SKIP, so a long session can be read a page at a time.' },
            messageChars: { type: 'number', description: 'Characters of each message to show. Defaults to 400; 0 shows them whole.' },
        },
    },
    search: {
        type: 'object', additionalProperties: false,
        properties: {
            query: { type: 'string', description: 'The phrase. It is quoted before FTS5 sees it, so quotes and operators in it are literal characters. Required.' },
            limit: { type: 'number', description: 'How many sessions to return. Defaults to 20.' },
        },
    },
    refresh: {
        type: 'object', additionalProperties: false,
        properties: {
            timeoutMs: { type: 'number', description: 'How long to WAIT for the rebuild before reporting it as still running. Defaults to 120000; the child keeps working either way.' },
        },
    },
}

const OUTPUT = {
    type: 'object', additionalProperties: false,
    properties: {
        action: { type: 'string' },
        count: { type: 'number', description: 'How many rows this answer carries.' },
        total: { type: 'number', description: 'How many matched before `limit`.' },
        query: { type: 'string' },
        // WHAT THE LIST IS A LIST OF. Both numbers ride every `list` answer, so `subagents: 'exclude'` (or the default)
        // is never silent about what it left out.
        subagents: { type: 'object', additionalProperties: false, properties: { subagentRuns: { type: 'number' }, ofTotal: { type: 'number' }, shown: { type: 'string' } } },
        sessionId: { type: 'string' },
        textIndexed: { type: 'boolean', description: 'FALSE means the store holds no message text, so "no matches" does not mean the phrase is absent from the conversations.' },
        searchMode: { type: 'string', description: 'Which mechanism answered: `fts5-trigram` (substring), `fts5` (words), or `like` (a scan).' },
        indexPath: { type: 'string' },
        published: { type: 'string', description: 'For `list`: the path this store was published to, as the row configured it.' },
        sessions: {
            type: 'array',
            items: {
                type: 'object', additionalProperties: false,
                properties: {
                    id: { type: 'string' }, title: { type: 'string' }, cwd: { type: 'string' }, createdAt: { type: 'number' },
                    hits: { type: 'number' }, matchedIn: { type: 'string' }, snippet: { type: 'string' },
                    events: { type: 'number' }, messages: { type: 'number' }, asks: { type: 'number' }, toolCalls: { type: 'number' },
                    // DECLARED BECAUSE IT IS EMITTED. `additionalProperties: false` means an undeclared field is refused
                    // at runtime -- the class of latent bug `F108` found in the observer's battery tool, where `got` was
                    // emitted and never declared. `origin` is `'subagent'` on a worker run and absent on a conversation;
                    // `parentSession` is the session this one was FORKED from (seed lineage), a different fact.
                    origin: { type: 'string' }, parentSession: { type: 'string' },
                },
            },
        },
        session: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, cwd: { type: 'string' }, createdAt: { type: 'number' }, title: { type: 'string' } } },
        slice: {
            type: 'object', additionalProperties: false,
            properties: {
                matched: { type: 'number' }, total: { type: 'number' },
                page: { type: 'object', additionalProperties: false, properties: { offset: { type: 'number' }, from: { type: 'number' }, to: { type: 'number' }, of: { type: 'number' } } },
                unknownKinds: { type: 'array', items: { type: 'string' } },
            },
        },
        coverage: {
            type: 'object', additionalProperties: false,
            description: 'HOW MUCH SESSION THERE IS, and what was left out: without it a reading of 3% of a conversation cannot be told from a reading of all of it.',
            properties: {
                events: { type: 'number' }, messages: { type: 'number' }, chars: { type: 'number' }, toolEvents: { type: 'number' },
                withdrawn: { type: 'number', description: 'Events withdrawn from the surface by a `replace`, so they are not in the conversation and are COUNTED rather than silently dropped.' },
                other: { type: 'number', description: 'Message events this tool does not read as a voice -- an injected note or a compaction checkpoint.' },
            },
        },
        messages: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { role: { type: 'string' }, text: { type: 'string' } } } },
        clipped: { type: 'number' },
        messageChars: { type: 'number' },
        refreshing: { type: 'boolean', description: 'For `refresh`: TRUE means the rebuild was still running when this answered.' },
        refolded: { type: 'number' }, skipped: { type: 'number' }, storeSizeMb: { type: 'number' }, elapsedMs: { type: 'number' },
        pid: { type: 'number' }, tokenizer: { type: 'string' },
        summary: { type: 'array', items: { type: 'string' } },
        problems: { type: 'array', items: { type: 'string' } },
        problem: { type: 'string' },
    },
}

const empty = { count: 0 }

const render = (_args, value) => {
    if (typeof value.problem === 'string' && value.problem !== '') return [{ type: 'text', text: 'UNAVAILABLE: ' + value.problem }]
    const lines = []
    if (value.action === 'list') {
        lines.push(`${value.count} session(s) in the store${value.total === undefined ? '' : ` of ${value.total} matched`}`)
        // THE MIXTURE, ON THE FIRST LINE A READER SEES. Most of this store is worker runs, and 20 rows of a list cannot
        // show that -- so the count is stated, with the filter that changes it, rather than left to be discovered.
        if (value.subagents !== undefined) {
            lines.push(`  ${value.subagents.subagentRuns} of ${value.subagents.ofTotal} session(s) in the store are SUBAGENT runs; this list is \`subagents: ${value.subagents.shown}\``)
        }
        for (const row of value.sessions ?? []) {
            lines.push(`  ${row.id} ${row.createdAt === undefined ? '' : new Date(row.createdAt).toISOString().slice(0, 16)} ${row.cwd ?? ''} ${row.title === undefined ? '(no title)' : '"' + row.title + '"'} -- ${row.events ?? 0} event(s), ${row.messages ?? 0} message(s), ${row.asks ?? 0} ask(s)${row.origin === undefined ? '' : ` [${row.origin}${row.parentSession === undefined ? '' : ` of ${row.parentSession}`}]`}`)
        }
    } else if (value.action === 'read') {
        lines.push(`session ${value.session?.id ?? '?'} ${value.session?.title === undefined ? '' : '"' + value.session.title + '"'} ${value.session?.cwd ?? ''}`)
        lines.push(`  ${value.slice?.matched ?? 0} of ${value.slice?.total ?? 0} event(s) matched`)
        const coverage = value.coverage
        if (coverage !== undefined) {
            lines.push(`  the whole session: ${coverage.events} event(s), ${coverage.messages} message(s), ${coverage.chars} char(s) of text, ${coverage.toolEvents} tool event(s)`)
            if (coverage.withdrawn > 0) lines.push(`  ${coverage.withdrawn} event(s) were WITHDRAWN by a surface replace, so they are not in the conversation`)
            if (coverage.other > 0) lines.push(`  ${coverage.other} message event(s) are neither voice (an injected note or a checkpoint) and are not shown`)
        }
        for (const message of value.messages ?? []) lines.push(`  ${message.role}: ${message.text}`)
        if ((value.clipped ?? 0) > 0) lines.push(`  ${value.clipped} message(s) are longer than the budget and are CUT: raise \`messageChars\`, or use 0 for whole messages`)
    } else if (value.action === 'search') {
        lines.push(`${value.count} session(s) matching ${JSON.stringify(value.query ?? '')} -- ${value.searchMode ?? '?'}${value.textIndexed === false ? ' (THE STORE HOLDS NO MESSAGE TEXT, so only titles, ids and directories were compared)' : ''}`)
        for (const row of value.sessions ?? []) {
            lines.push(`  ${row.id} ${row.cwd ?? ''} ${row.title === undefined ? '' : '"' + row.title + '"'}`)
            if (row.matchedIn !== undefined) lines.push(`    matched in: ${row.matchedIn}${row.hits === undefined ? '' : ` (${row.hits} row(s))`}`)
            if (row.snippet !== undefined) lines.push(`    ${row.snippet.split('\n').join(' ').slice(0, 300)}`)
        }
    } else if (value.action === 'refresh') {
        lines.push(value.refreshing === true
            ? `the store is being rebuilt in pid ${value.pid ?? '?'}, ${Math.round((value.elapsedMs ?? 0) / 1000)} s so far -- it reads only the sessions that CHANGED, and the store stays readable`
            : `the store is current: refolded ${value.refolded ?? 0}, skipped ${value.skipped ?? 0} unchanged, ${value.storeSizeMb ?? '?'} MB, in ${Math.round((value.elapsedMs ?? 0) / 1000)} s`)
        for (const line of value.summary ?? []) lines.push('  ' + line)
    }
    for (const problem of value.problems ?? []) lines.push('PROBLEM: ' + problem)
    return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * A tool that CANNOT THROW, because a thrown error is not an answer a model can read.
 *
 * Measured in the plugin this was extracted from: `checkAgainst` throws on a bad argument, and an earlier tool read
 * `.problem` off its own `undefined` return and failed every call. So the check is caught here and becomes a named
 * problem, which is the shape every caller already handles.
 */
/**
 * OUR RAW DECLARATION -> THE AUTHORED PARAMETER MAP, because `defineTool` takes the IMPLICIT open root (a property map)
 * rather than a `{type:'object', ...}` wrapper -- which is also what retires the raw-root `additionalProperties`
 * deviation a compliance audit found (`F107`): there is no root wrapper here to declare anything on.
 *
 * The DSL also says required-ness belongs on the PROPERTY (`required: true`), so a raw `required: [...]` list is folded
 * onto the properties it names. Our own `checkAgainst` still runs against the RAW declaration, so nothing about the
 * tool's behaviour changes.
 */
function asParameterMap(parameters) {
    if (parameters === undefined || parameters === null) return {}
    if (parameters.type !== 'object' || parameters.properties === undefined) return parameters
    const required = Array.isArray(parameters.required) ? parameters.required : []
    const map = {}
    for (const [key, spec] of Object.entries(parameters.properties)) {
        map[key] = required.includes(key) ? { ...spec, required: true } : spec
    }
    return map
}

// AUTHORED WITH `defineTool`, which is the contract's form and which runs the harness's own schema validation at
// registration. The package is a dependency now, not a devDependency, which is what made this possible (`F107`).
const tool = (name, parameters, run) => defineTool({
    name,
    description: DESCRIPTIONS[name],
    parameters: asParameterMap(parameters),
    output: { schema: OUTPUT, render },
    async execute(args) {
        const asked = args ?? {}
        const action = name.replace('session_index_', '')
        // TWO KINDS OF FAILURE, NAMED DIFFERENTLY ON PURPOSE, because a caller acts on them differently:
        //   `problem`  the CALL could not be made at all (an argument the tool does not declare, or the wrong type);
        //   `problems` the call was made and the WORK could not be done (no store yet, a file that is gone).
        try {
            checkAgainst(parameters, asked, name)
        } catch (error) {
            return { ...empty, action, problem: error instanceof Error ? error.message : String(error) }
        }
        try {
            return await run(asked)
        } catch (error) {
            return { ...empty, action, problems: [error instanceof Error ? error.message : String(error)] }
        }
    },
})
const DESCRIPTIONS = {
    [TOOL.list]: 'List stored sessions: their ids, titles, working directories and size. Reads the INDEX, so it shows what the last build saw -- call `session_index_refresh` for what is there now.',
    [TOOL.read]: 'Read one stored session\'s conversation -- operator and assistant messages, with how much session there is and what was left out. This is the session library\'s reader; it composes nothing for a judge.',
    [TOOL.search]: 'Search stored sessions for a phrase: message text, reasoning, tool results and tool-call arguments. Says WHICH mechanism answered (an FTS5 mirror, or a scan), so a "no matches" is never mistaken for "not there".',
    [TOOL.refresh]: 'Bring the store current: an INCREMENTAL rebuild of the sessions that changed, in a child process, preserving the store\'s text mode and tokenizer. Reports whether it finished or is still running.',
}

/** The four tools, wired to one store. */
export function createTools({ service }) {
    return [
        tool(TOOL.list, PARAMETERS.list, async (asked) => {
            const limit = typeof asked.limit === 'number' && asked.limit > 0 ? Math.floor(asked.limit) : 20
            const subagents = ['include', 'exclude', 'only'].includes(asked.subagents) ? asked.subagents : 'include'
            let rows
            let meta
            let counts = { total: 0, subagents: 0 }
            try {
                rows = await service.list({ cwd: asked.cwd ?? null, search: asked.search ?? null, subagents, limit })
                meta = await service.meta()
                counts = await service.counts()
            } catch (error) {
                // A RAW STORE ERROR IS NOT A DIAGNOSIS. "unable to open database file" tells a model nothing it can act
                // on; the path and the one action that fixes it do.
                return { ...empty, action: 'list', indexPath: service.path, problems: [`no readable store at ${service.path} (${error instanceof Error ? error.message : String(error)}) -- call \`${TOOL.refresh}\` to build it`] }
            }
            {
                return {
                    action: 'list', count: rows.length, total: Number(meta.sessions ?? rows.length), indexPath: service.path,
                    // THE MIXTURE, ALWAYS ON THE LINE. A reader looking at 20 rows cannot tell whether the store behind
                    // them holds 20 or 499, and 64% of those are subagent runs -- so both numbers ride every list.
                    subagents: { subagentRuns: counts.subagents, ofTotal: counts.total, shown: subagents },
                    sessions: rows.map((row) => ({
                        id: row.id, createdAt: row.created_at ?? undefined, ...(row.title === null ? {} : { title: String(row.title) }),
                        ...(row.cwd === null ? {} : { cwd: String(row.cwd) }), events: row.events, messages: row.messages, asks: row.asks, toolCalls: row.tool_calls,
                        // WHERE A ROW CAME FROM, because it decides whether it is a conversation at all: `origin` is
                        // the harness's own "this is a subagent child"; `parentSession` is fork lineage, and the two are
                        // reported separately rather than conflated.
                        ...(row.origin === null || row.origin === undefined ? {} : { origin: String(row.origin) }),
                        ...(row.parent_session === null || row.parent_session === undefined ? {} : { parentSession: String(row.parent_session) }),
                    })),
                }
            }
        }),
        tool(TOOL.read, PARAMETERS.read, async (asked) => {
            if (typeof asked.sessionId !== 'string' || asked.sessionId.trim() === '') return { ...empty, action: 'read', problems: ['`sessionId` is required'] }
            const read = await service.read(asked.sessionId.trim(), {
                ...(Array.isArray(asked.kinds) ? { kinds: asked.kinds } : {}),
                ...(typeof asked.lastMessages === 'number' ? { lastMessages: Math.max(0, Math.floor(asked.lastMessages)) } : {}),
                ...(typeof asked.offset === 'number' ? { offset: Math.max(0, Math.floor(asked.offset)) } : {}),
                ...(typeof asked.messageChars === 'number' ? { messageChars: Math.max(0, Math.floor(asked.messageChars)) } : {}),
            })
            if (read.problem !== undefined) return { ...empty, action: 'read', sessionId: asked.sessionId, problem: read.problem }
            return { action: 'read', sessionId: asked.sessionId, count: read.messages.length, indexPath: service.path, ...read }
        }),
        tool(TOOL.search, PARAMETERS.search, async (asked) => {
            const query = typeof asked.query === 'string' ? asked.query.trim() : ''
            if (query === '') return { ...empty, action: 'search', query: '', problems: ['`query` is required'] }
            const limit = typeof asked.limit === 'number' && asked.limit > 0 ? Math.floor(asked.limit) : 20
            let found
            try {
                found = await service.search(query, { limit })
            } catch (error) {
                // A STORE THAT IS NOT THERE IS NOT A STORE WITH NO TEXT, and a reader must be able to tell: no text means
                // "the phrase may still be in the conversations", a missing store means "nothing was searched".
                return { ...empty, action: 'search', query, textIndexed: false, searchMode: 'none', indexPath: service.path, problems: [`no readable store at ${service.path} (${error instanceof Error ? error.message : String(error)}) -- call \`${TOOL.refresh}\` to build it`] }
            }
            const clients = found.rows.map((row) => ({
                id: row.id, hits: row.hits, matchedIn: row.matchedIn, ...(row.title === null || row.title === undefined ? {} : { title: String(row.title) }),
                ...(row.cwd === null || row.cwd === undefined ? {} : { cwd: String(row.cwd) }), ...(typeof row.createdAt === 'number' ? { createdAt: row.createdAt } : {}),
                ...(typeof row.snippet === 'string' && row.snippet !== '' ? { snippet: row.snippet } : {}),
            }))
            return { action: 'search', query, count: clients.length, total: found.total, textIndexed: found.textIndexed === true, searchMode: found.searchMode, indexPath: found.path, sessions: clients }
        }),
        // THE SERVICE, NOT THE MODULE: it carries the configured sessions directory and tokenizer, so a rebuild reads
        // the sessions the store was built from. Getting this wrong once made a test read the REAL sessions directory,
        // because passing only the output path leaves the builder on its own default.
        tool(TOOL.refresh, PARAMETERS.refresh, async (asked) => {
            const refreshed = await service.refresh(typeof asked.timeoutMs === 'number' && asked.timeoutMs > 0 ? { timeoutMs: Math.floor(asked.timeoutMs) } : {})
            return { action: 'refresh', ...refreshed }
        }),
    ]
}

export { PARAMETERS as TOOL_PARAMETERS, OUTPUT as TOOL_OUTPUT, TOOL as TOOL_NAMES }
