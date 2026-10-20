// THE FOUR COLUMNS OF SCHEMA VERSION 6, and each one exists because a measurement of the corpus found the two
// producers of a session disagreeing about something this store was not holding.
//
// The corpus run over the 946 live sessions is what found them, and it found them by COMPOSING each session both ways --
// from the log and from the index -- and comparing the result. The composed state agreed in 945 of 946 sessions (it
// agrees in all 946 now), but the EVIDENCE around that reading did not: the receipt's byte count meant two different
// things, the tool arguments were cut with no length beside them, and 120 interruption facts had nowhere to live.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildIndex, foldSession, sessionLines } from '../lib/build.js'
import { listSessions } from '../lib/store.js'

/** A fixture with a corpus directory, an interrupted message, and a tool call with a long argument. */
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'schema-v6-'))
    const id = 'session-abc'
    const dir = join(root, '--home-john-CodingProjects-zeroclaw-voice-proxy--', id)
    mkdirSync(dir, { recursive: true })
    const longArgument = 'x'.repeat(5000)
    const lines = [
        { type: 'session', version: 4, id, createdAt: 1789873194109, cwd: '/home/john/CodingProjects/zeroclaw-voice-proxy' },
        { type: 'user/message', seq: 1, time: 1, data: { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'push this repo' }] } },
        // ONE MESSAGE THE MODEL WAS CUT OFF IN, and one it was not: the difference is a fact, and `false` is not the
        // same fact as "nobody said".
        { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, interrupted: true, message: { content: [{ type: 'text', text: 'cut off' }] } } },
        { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, message: { content: [{ type: 'text', text: 'finished' }] } } },
        { type: 'tool/call', seq: 4, time: 4, data: { callId: 'c1', name: 'bash', arguments: longArgument } },
    ]
    writeFileSync(join(dir, 'session.v4.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return { root, id, dir, longArgument }
}

test('THE CORPUS IS THE DIRECTORY ABOVE THE SESSION ID, because one index holds every corpus', () => {
    const f = fixture()
    try {
        const out = join(f.root, 'index.db')
        buildIndex({ sessionsDir: f.root, out, withText: true })
        const db = new DatabaseSync(out, { readOnly: true })
        const row = db.prepare('SELECT corpus FROM sessions WHERE id = ?').get(f.id)
        // THE SEGMENT OF THE SESSIONS ROOT ABOVE THE SESSION, which is the subject the harness keeps the session under.
        // It is RELATIVE to the root, so it says WHICH corpus and not where the root happens to be.
        assert.equal(row.corpus, '--home-john-CodingProjects-zeroclaw-voice-proxy--')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('THE LIST FILTERS BY CORPUS, so "every session of this project" is a filter and not another file', async () => {
    const f = fixture()
    try {
        const out = join(f.root, 'index.db')
        buildIndex({ sessionsDir: f.root, out, withText: true })
        const all = await listSessions({ path: out, corpus: null, limit: 20 })
        const one = await listSessions({ path: out, corpus: '--home-john-CodingProjects-zeroclaw-voice-proxy--', limit: 20 })
        const none = await listSessions({ path: out, corpus: '--home-john-CodingProjects-something-else--', limit: 20 })
        assert.equal(all.length, 1, 'the corpus filter does not hide the session when it is not asked for')
        assert.equal(one.length, 1, 'and it finds the session when it is')
        assert.equal(none.length, 0, 'and it is a filter, not a second store')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('THE DECODED LENGTH IS BESIDE THE ON-DISK SIZE, because the receipt names the bytes that were READ', () => {
    const f = fixture()
    try {
        const out = join(f.root, 'index.db')
        buildIndex({ sessionsDir: f.root, out, withText: true })
        const db = new DatabaseSync(out, { readOnly: true })
        const row = db.prepare('SELECT bytes, decoded_bytes FROM sessions WHERE id = ?').get(f.id)
        // THE ON-DISK SIZE IS THE COMPRESSED FILE, and the DECODED length is the conversation -- two different facts
        // that the receipt's one name used to carry (F182). They are EQUAL for an uncompressed fixture, which is
        // exactly why the difference only ever shows up on a real corpus: every log here is a compressed one.
        assert.ok(row.decoded_bytes > 0, 'the decoded length is recorded')
        assert.equal(row.decoded_bytes, Buffer.byteLength(readFileSync(join(f.dir, 'session.v4.jsonl'), 'utf8'), 'utf8'))
        assert.equal(row.decoded_bytes, row.bytes, 'and for an uncompressed file the two lengths are the same')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('THE ARGUMENTS ARE CAPPED AND THEIR FULL LENGTH IS KEPT, so a cut argument is not a short one', () => {
    const f = fixture()
    try {
        const out = join(f.root, 'index.db')
        buildIndex({ sessionsDir: f.root, out, withText: true })
        const db = new DatabaseSync(out, { readOnly: true })
        const row = db.prepare('SELECT length(args) AS stored, args_chars FROM tool_calls WHERE session_id = ?').get(f.id)
        // THE CAP IS THE STORE'S OWN ORDER OF MAGNITUDE -- 4,000 characters -- and the FULL LENGTH is stored beside it.
        // The store already does this for tool RESULTS; a truncated argument with no length reads as a short argument.
        assert.equal(row.stored, 4000, 'the copy is capped')
        assert.equal(row.args_chars, f.longArgument.length, 'and the full length is beside it')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('THE INTERRUPTION IS A FACT, AND ITS ABSENCE IS NULL, not false', () => {
    const f = fixture()
    try {
        const out = join(f.root, 'index.db')
        buildIndex({ sessionsDir: f.root, out, withText: true })
        const db = new DatabaseSync(out, { readOnly: true })
        const rows = db.prepare('SELECT seq, interrupted FROM messages WHERE session_id = ? ORDER BY seq').all(f.id)
        // THE MESSAGE THE MODEL WAS CUT OFF IN says 1, and the one that says nothing about it says NULL -- which is
        // what the observer's producer says, so the two channels answer the same question the same way.
        assert.equal(rows.find((r) => r.seq === 2).interrupted, 1, 'the interrupted message is marked')
        assert.equal(rows.find((r) => r.seq === 3).interrupted, null, 'and the silent one is NULL, not false')
        assert.equal(rows.find((r) => r.seq === 1).interrupted, null, 'and so is a message that never had the field')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('THE FOLD CARRIES THE SAME FACTS, because the store is the producer and the fold is where it reads them', () => {
    const f = fixture()
    try {
        const { text, sha256 } = sessionLines(join(f.dir, 'session.v4.jsonl'))
        const folded = foldSession({
            id: f.id, path: 'x', version: 4, text, sha256, bytes: 1,
            corpus: '--home-john-CodingProjects-zeroclaw-voice-proxy--', decodedBytes: Buffer.byteLength(text, 'utf8'),
        })
        assert.equal(folded.row.corpus, '--home-john-CodingProjects-zeroclaw-voice-proxy--')
        assert.equal(folded.row.decoded_bytes, Buffer.byteLength(text, 'utf8'))
        // THE ROW LAYOUT: 9 is `interrupted`, and a message that never had the field carries NULL rather than 0.
        const cut = folded.messages.find((m) => m[1] === 2)
        const quiet = folded.messages.find((m) => m[1] === 3)
        assert.equal(cut[9], 1)
        assert.equal(quiet[9], null)
        // AND THE CALL'S LENGTH IS BESIDE THE CAPPED COPY: 0 id, 1 call id, 2 name, 3 args, 4 args length, 5 seq.
        assert.equal(folded.calls[0][3].length, 4000)
        assert.equal(folded.calls[0][4], f.longArgument.length)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
})
