// THE TEXT OF A MESSAGE, and the rule the rows contract states.
//
// The two producers of the same row kind extracted the same message's text DIFFERENTLY: the observer's producer
// trimmed it and this one did not, so ONE message had TWO texts -- 58 characters in the file channel and 59 in the
// index, the difference being a trailing space -- and **53 of the 946 sessions in the live corpus differ that way**.
// The consequence is not cosmetic: the `stateHash` of a measurement is made of this text, so a reading taken from the
// index and a reading taken from the file were DIFFERENT READINGS of one session, and neither could say so.
//
// So the rule is stated here, in the producer, and pinned by the cases below.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blockText, foldSession, sessionLines } from '../lib/build.js'

test('the text of a message is trimmed at both ends, and the middle is the model\'s', () => {
    assert.equal(blockText([{ type: 'text', text: 'push this repo ' }], ['text']), 'push this repo')
    assert.equal(blockText([{ type: 'text', text: '  padded  ' }], ['text']), 'padded')
    assert.equal(blockText('a string body ', ['text']), 'a string body')
    // AND THE WHITESPACE INSIDE IS KEPT, because it is the model's and a judge can be asked about it.
    assert.equal(blockText([{ type: 'text', text: 'a  b' }], ['text']), 'a  b')
})

test('reasoning blocks are joined by a newline, and a `thinking` block is not a reasoning block', () => {
    assert.equal(blockText([{ type: 'reasoning', text: 'first' }, { type: 'reasoning', text: 'second' }], ['reasoning'], '\n'), 'first\nsecond')
    // PI'S `thinking` IS RENAMED TO `reasoning` ON THE WAY IN, so accepting both here would be a second way to read
    // one vocabulary -- and the observer, which measures, accepts only `reasoning`.
    assert.equal(blockText([{ type: 'thinking', thinking: 'hmm' }], ['reasoning'], '\n'), '')
})

test('a block whose text is not a string is not text, and a thinking field is never visible text', () => {
    // A block that CLAIMS to be text and carries reasoning is not text: the observer's reader returns nothing for it,
    // and this used to surface its reasoning as VISIBLE TEXT -- which is the thing the session vocabulary's own header
    // warns about, reasoning is not text.
    assert.equal(blockText([{ type: 'text', thinking: 'a secret' }], ['text']), '')
    // AND A NON-STRING TEXT IS NOT TEXT: a number became its digits here and nothing there.
    assert.equal(blockText([{ type: 'text', text: 42 }], ['text']), '')
})

test('THE INDEXED ROW CARRIES THE TRIMMED TEXT, which is the whole point', () => {
    const root = mkdtempSync(join(tmpdir(), 'text-rule-'))
    const id = 'session-text'
    const dir = join(root, 'proj', id)
    mkdirSync(dir, { recursive: true })
    const lines = [
        { type: 'session', version: 4, id, createdAt: 1789873194109, cwd: '/tmp' },
        { type: 'user/message', seq: 1, time: 1, data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'push this repo ' }] } },
        { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'first' }, { type: 'reasoning', text: 'second' }, { type: 'text', text: 'done ' }] } } },
    ]
    writeFileSync(join(dir, 'session.v4.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const { text, sha256 } = sessionLines(join(dir, 'session.v4.jsonl'))
    const { messages } = foldSession({ id, path: 'x', version: 4, text, sha256, bytes: 1 })
    // THE ROW LAYOUT, so a number below is not a guess: 0 id, 1 seq, 2 turn, 3 exchange, 4 role, 5 kind, 6 text,
    // 7 reasoning, 8 shadowed.
    assert.equal(messages[0][6], 'push this repo', 'the user text is trimmed')
    assert.equal(messages[1][6], 'done', 'the assistant text is trimmed')
    assert.equal(messages[1][7], 'first\nsecond', 'and two reasoning blocks are one text, joined by a newline')
})

test('A NUL BYTE IS REPLACED, because SQLite would keep only the bytes before it', () => {
    // THE MEASUREMENT. `node:sqlite` binds a string with NUL-terminated semantics, so a text holding a NUL is stored as
    // the characters BEFORE it and nothing after. Measured on this host: 67 messages in 1 of 946 sessions carried one,
    // and the index held 11 characters where the log held 100 -- the other 89 were not shortened, they were GONE, and the
    // row read as though the model had said less. Two tool-call names became empty strings the same way.
    //
    // The fix is the observer's rows contract RULE 7, applied on both sides: a NUL becomes U+FFFD, so the text keeps its
    // length, the reader can see that something was there, and the two channels produce the same characters.
    assert.equal(blockText([{ type: 'text', text: 'before\u0000after' }], ['text']), 'before\uFFFDafter')
    assert.equal(blockText([{ type: 'text', text: '\u0000' }], ['text']), '\uFFFD')
    // AND THE LENGTH IS KEPT, because a text that shrank would be a different measurement rather than a marked one.
    assert.equal(blockText([{ type: 'text', text: 'a\u0000b' }], ['text']).length, 3)
    // AND A TEXT WITH NO NUL IS UNTOUCHED, because a rule that always changes the text is a rule that cannot be trusted.
    assert.equal(blockText([{ type: 'text', text: 'plain text' }], ['text']), 'plain text')
})

test('THE INDEXED ROW CARRIES NO NUL, and the tool call keeps its name', () => {
    const root = mkdtempSync(join(tmpdir(), 'nul-rule-'))
    const id = 'session-nul'
    const dir = join(root, 'proj', id)
    mkdirSync(dir, { recursive: true })
    const lines = [
        { type: 'session', version: 4, id, createdAt: 1789873194109, cwd: '/tmp' },
        { type: 'user/message', seq: 1, time: 1, data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
        { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, message: { content: [{ type: 'text', text: 'a\u0000b' }] } } },
        { type: 'tool/call', seq: 3, time: 3, data: { callId: 'c1', name: '\u0000bash', arguments: 'echo \u0000 hi' } },
    ]
    writeFileSync(join(dir, 'session.v4.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const { text, sha256 } = sessionLines(join(dir, 'session.v4.jsonl'))
    const { messages, calls } = foldSession({ id, path: 'x', version: 4, text, sha256, bytes: 1 })
    // THE ROW LAYOUT: 0 id, 1 seq, 2 turn, 3 exchange, 4 role, 5 kind, 6 text, 7 reasoning, 8 shadowed.
    assert.equal(messages[1][6], 'a\uFFFDb', 'the NUL is replaced, so the text keeps its length')
    assert.ok(!messages[1][6].includes('\u0000'), 'and no NUL reaches the column')
    // AND THE TOOL CALL KEEPS ITS NAME: the log held a NUL-prefixed name, and the index held an EMPTY STRING, which is
    // a call that names no tool at all.
    assert.equal(calls[0][2], '\uFFFDbash', 'the name is kept, with the NUL marked')
    assert.ok(!calls[0][3].includes('\u0000'), 'and the arguments carry no NUL either')
})
