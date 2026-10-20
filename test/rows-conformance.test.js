// THE CONFORMANCE FIXTURE, and this store is checked against it.
//
// WHY A FIXTURE AND NOT A CORPUS. The two channels -- the LOG (`dsh-system1-observer`'s producer) and the INDEX (this
// store's producer, read back through the observer's `core/rows-sqlite.js`) -- were compared over the whole live
// corpus, and that comparison is what found the five defects in the observer's findings register: about who spoke
// (**F173**), about the digest (**F174**), about the text of a message (**F177**), about a block's `thinking` field
// (**F179**) and about a NUL byte (**F180**). But a corpus cannot be a GATE: it lives on one machine, it changes under
// you, and a test that needs 946 sessions and 1.5 GB of index is a test nobody runs.
//
// So the rules are said ONCE, in the package `dsh-session-rows`, and the FIXTURE says what they produce. This store
// vendors the fixture and pins its digest, so a fixture that changes in the package cannot be quietly different here.
//
// ONE DIFFERENCE IS EXPECTED AND NAMED: this store calls the harness `harness` where the rows contract calls it
// `system`, and the observer's reader translates. That is a NAMING difference -- the two are the same fact -- and it
// is the only thing this test has to account for.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { foldSession, sessionLines } from '../lib/build.js'

/** The vendored fixture, and the digest the package computes for it. */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/session-rows')

/**
 * THE PINNED DIGEST, and it is the package's own: the package hashes the file NAME and then the bytes, in the order
 * it declares them, so a swapped pair or a renamed file changes it.
 */
const PINNED_DIGEST = '0ad4b17869f237aebedee14d81aaa7b4c058af5d33df52a200a1c622ebed2372'

const FIXTURE_FILES = ['fixture/session.v4.jsonl', 'fixture/rows.jsonl']

/** The digest of a fixture held here, computed the way the package computes it. */
const digestOf = (root) => {
    const hash = createHash('sha256')
    for (const file of FIXTURE_FILES) {
        hash.update(file)
        hash.update(readFileSync(join(root, file.split('/').pop())))
    }
    return hash.digest('hex')
}

/** The fixture's rows, folded by THIS store, and read in the store's own row layout. */
const foldedRows = () => {
    const { text, sha256 } = sessionLines(join(FIXTURE, 'session.v4.jsonl'))
    const { messages, calls } = foldSession({ id: 'conformance-1', path: 'x', version: 4, text, sha256, bytes: 1 })
    return { messages, calls }
}

/** The fixture's expected rows, read as they are written. */
const expectedRows = () => readFileSync(join(FIXTURE, 'rows.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))

/**
 * THE ROLE, IN THE CONTRACT'S VOCABULARY. The store's own name for the harness speaking is `harness` -- it is a
 * column of this store, and the rows contract has no such word -- and the observer's reader translates it. So the
 * comparison translates it too, and says so, rather than pretending the two vocabularies are the same.
 */
const roleInTheContract = (kind) => (kind === 'user' ? 'user' : (kind === 'assistant' ? 'assistant' : 'system'))

test('THE VENDORED FIXTURE IS THE PACKAGE\'S, and the digest says so', () => {
    assert.equal(digestOf(FIXTURE), PINNED_DIGEST, 'the vendored fixture is not the one the package ships; update it and the digest together')
})

test('THIS STORE PRODUCES THE FIXTURE\'S MESSAGES, field for field', () => {
    const { messages } = foldedRows()
    const expected = expectedRows().filter((row) => row.kind === 'message')
    assert.equal(messages.length, expected.length, 'this store and the fixture disagree on how many messages there are')
    for (const want of expected) {
        const got = messages.find((row) => row[1] === want.seq)
        assert.notEqual(got, undefined, `the fixture has a message at seq ${want.seq} and this store does not`)
        // THE ROW LAYOUT: 0 id, 1 seq, 2 turn, 3 exchange, 4 role, 5 kind, 6 text, 7 reasoning, 8 shadowed, 9 interrupted.
        assert.equal(got[3], want.exchange, `the ask-group of seq ${want.seq}`)
        assert.equal(roleInTheContract(got[5]), want.role, `the role of seq ${want.seq}`)
        assert.equal(got[6], want.text, `the text of seq ${want.seq}`)
        assert.equal(got[7] ?? null, want.reasoning, `the reasoning of seq ${want.seq}`)
        assert.equal(got[8] === 1, want.shadowed, `the shadowed flag of seq ${want.seq}`)
        assert.equal(got[9] === 1, want.interrupted === true, `the interruption of seq ${want.seq}`)
        assert.equal(got[9] === null, want.interrupted === null, `and its ABSENCE, which is not the same as false`)
    }
})

test('AND ITS TOOL CALL, with the name and the arguments', () => {
    const { calls } = foldedRows()
    const want = expectedRows().find((row) => row.kind === 'tool_call')
    assert.equal(calls.length, 1, 'this store and the fixture disagree on how many tool calls there are')
    // THE CALL ROW: 0 id, 1 call id, 2 name, 3 args, 4 the FULL length of the args, 5 seq.
    assert.equal(calls[0][1], want.callId)
    assert.equal(calls[0][2], want.name)
    assert.equal(calls[0][3], want.args)
    assert.equal(calls[0][4], want.args.length, 'and the full length of the arguments is beside the copy')
})

test('AND THE FIXTURE EXERCISES EVERY RULE, or it is decoration', () => {
    const rows = expectedRows()
    const messages = rows.filter((row) => row.kind === 'message')
    assert.ok(messages.some((row) => row.text === 'push this repo'), 'a trimmed text')
    assert.ok(messages.some((row) => row.text.includes('\uFFFD')), 'a NUL byte, replaced')
    assert.ok(!JSON.stringify(rows).includes('\u0000'), 'and no row carries a NUL')
    assert.ok(messages.some((row) => row.shadowed === true), 'a shadowed message')
    assert.ok(messages.some((row) => row.role === 'system'), 'the harness speaking')
    assert.ok(messages.some((row) => row.role === 'user'), 'and the human')
    assert.ok(messages.some((row) => row.interrupted === true), 'an interrupted message')
    assert.ok(messages.some((row) => row.interrupted === null), 'and one that never said')
})
