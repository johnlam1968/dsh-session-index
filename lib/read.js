// READING ONE SESSION, from its own LOG rather than from the index.
//
// WHY IT DECODES THE FILE: the index holds counts, titles and searchable text, not the conversation in order. A reader
// wants the messages as they were said, so it finds the file through the index (`sessionRow`) and decodes it with the
// same decoder the builder uses -- one home for "how a session log becomes lines".
//
// WHAT IT DELIBERATELY IS NOT: it is not the observer's subject composition. There is no OBSERVE allow-list, no
// composer, no judge's budget and no `state` -- those are MEASUREMENT semantics, and a session library that carried
// them would be useless to a deployment that measures nothing.
//
// THE SURFACE IS RESPECTED: an event withdrawn by a `surfaceOp: replace` is not in the conversation any more, so it is
// left out and COUNTED as left out (`withdrawn`), because a reader who cannot see the omission cannot tell a short
// session from a truncated read.

import { sessionRow } from './store.js'

const OPERATOR = 'operator'
const ASSISTANT = 'assistant'

/** The text of a message event, for the two roles this plugin reads. `null` for anything else. */
function messageOf(event) {
    const data = event?.data ?? {}
    if (event?.type === 'assistant/message') {
        const blocks = Array.isArray(data.message?.content) ? data.message.content : []
        const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('')
        return text === '' ? null : { role: ASSISTANT, text }
    }
    if (event?.type === 'user/message') {
        const kind = data.source?.kind ?? 'user'
        const content = Array.isArray(data.content) ? data.content : [{ type: 'text', text: typeof data.content === 'string' ? data.content : '' }]
        const text = content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('')
        if (text === '') return null
        // ONLY A HUMAN ASK IS AN OPERATOR MESSAGE. An injected note or a compaction checkpoint is neither the operator
        // nor the agent, and folding one into the other would misattribute what was said.
        return { role: kind === 'user' ? OPERATOR : kind, text }
    }
    return null
}

/**
 * Read one stored session.
 *
 * @returns `{ session, slice, coverage, messages, clipped }`, or `{ problem }` naming what could not be done -- a
 *          missing session, an unreadable file and an empty session never look alike.
 */
export async function readSession(sessionId, { path, sessionsDir = undefined, kinds = [OPERATOR, ASSISTANT], lastMessages = 0, offset = 0, messageChars = 400 } = {}) {
    const row = await sessionRow(sessionId, { path })
    if (row === null) {
        return { problem: `no session ${JSON.stringify(String(sessionId))} in the index at ${path} -- \`list\` shows what it holds, and \`refresh\` brings it current` }
    }
    const { sessionLines } = await import('./build.js')
    let lines
    try {
        lines = sessionLines(row.path)
    } catch (error) {
        return { problem: `the session file could not be read (${error instanceof Error ? error.message : String(error)}): ${row.path}` }
    }
    const events = []
    for (const line of lines.text.split('\n')) {
        if (line.trim() === '') continue
        try { events.push(JSON.parse(line)) } catch { /* a log's last line can be a partial write: counted, not guessed */ }
    }
    const withdrawn = new Set()
    for (const event of events) {
        const op = event?.surfaceOp
        if (op !== undefined && op.op === 'replace') {
            for (let seq = op.startSeq; seq <= op.endSeq; seq += 1) withdrawn.add(seq)
        }
    }
    const all = []
    let toolEvents = 0
    let messageEvents = 0
    let chars = 0
    for (const event of events) {
        if (event?.type === 'tool/call' || event?.type === 'tool/result') toolEvents += 1
        const message = messageOf(event)
        if (message === null) continue
        messageEvents += 1
        chars += message.text.length
        if (event.seq !== undefined && withdrawn.has(event.seq)) continue
        all.push({ seq: event.seq, role: message.role, text: message.text })
    }
    const wanted = all.filter((m) => kinds.includes(m.role))
    const unknownKinds = kinds.filter((kind) => kind !== OPERATOR && kind !== ASSISTANT)
    const newestFirst = wanted.slice().reverse()
    const paged = (lastMessages > 0 ? newestFirst.slice(offset, offset + lastMessages) : newestFirst.slice(offset)).reverse()
    const clipped = paged.filter((m) => messageChars > 0 && m.text.length > messageChars).length
    return {
        session: { id: row.id, cwd: row.cwd ?? undefined, createdAt: row.created_at ?? undefined, title: row.title ?? undefined },
        slice: {
            matched: wanted.length,
            total: events.length,
            page: { offset, from: Math.max(0, wanted.length - offset - paged.length), to: Math.max(0, wanted.length - offset), of: wanted.length },
            ...(unknownKinds.length > 0 ? { unknownKinds } : {}),
        },
        coverage: { events: events.length, messages: messageEvents, chars, toolEvents, withdrawn: withdrawn.size, other: messageEvents - all.length },
        messages: paged.map((m) => ({ role: m.role, text: messageChars > 0 && m.text.length > messageChars ? m.text.slice(0, messageChars) : m.text })),
        ...(clipped > 0 ? { clipped } : {}),
    }
}
