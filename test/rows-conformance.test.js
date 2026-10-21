// THE CONFORMANCE FIXTURE, and this store is checked against it.
//
// WHY A FIXTURE AND NOT A CORPUS. The two channels -- the LOG (`dsh-system1-observer`'s producer) and the INDEX (this
// store's producer, read back through the observer's `core/rows-sqlite.js`) -- were compared over the whole live
// corpus, and that comparison is what found the five defects in the observer's findings register: about who spoke
// (**F173**), about the digest (**F174**), about the text of a message (**F177**), about a block's `thinking` field
// (**F179**) and about a NUL byte (**F180**). But a corpus cannot be a GATE: it lives on one machine, it changes under
// you, and a test that needs 946 sessions and 1.5 GB of index is a test nobody runs.
//
// So the rules are said ONCE, in the package `system1-measure/rules`, and the FIXTURE says what they produce. This store
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
const PINNED_DIGEST = '27bb1c0c893adb4f6b52648fdff32cb17b39022f8dbea53451ac5f84058cdb66'

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
 *
 * AND THE STORE'S OWN ROLE COLUMN IS ASSERTED, not only derived. It used to be that this test compared the KIND
 * column -- the SOURCE kind -- and derived the role from it, so the store's own role column was never compared to
 * anything: mutating the store's role mapping from `harness` to `user` left the whole suite green, with the
 * producer's vocabulary now the opposite of the contract's and the test silent about it. A test that NAMES a
 * difference and never ASSERTS it is a comment, and a comment is not a gate.
 */
const roleInTheContract = (kind) => (kind === 'user' ? 'user' : (kind === 'assistant' ? 'assistant' : 'system'))

/** The role the STORE writes, for the contract's role. The one named difference, in one place. */
const roleInTheStore = (role) => (role === 'system' ? 'harness' : role)

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
        // THE ROLE COLUMN, asserted in the store's OWN vocabulary, which is the one named difference: the store says
        // `harness` where the contract says `system`, and the observer's reader translates it.
        assert.equal(got[4], roleInTheStore(want.role), `the role of seq ${want.seq}, in the store's own vocabulary`)
        // AND THE KIND COLUMN, which is the SOURCE kind and not the contract's `type` -- the contract's `type` is the
        // BODY kind (`text`), and the store has no column for it. So the kind is compared as what it is.
        assert.equal(roleInTheContract(got[5]), want.role, `the source kind of seq ${want.seq}`)
        assert.equal(got[6], want.text, `the text of seq ${want.seq}`)
        assert.equal(got[7] ?? null, want.reasoning, `the reasoning of seq ${want.seq}`)
        assert.equal(got[8] === 1, want.shadowed, `the shadowed flag of seq ${want.seq}`)
        assert.equal(got[9] === 1, want.interrupted === true, `the interruption of seq ${want.seq}`)
        assert.equal(got[9] === null, want.interrupted === null, `and its ABSENCE, which is not the same as false`)
        // AND A STATED `false` IS NOT THE ABSENCE: the store's column is 0 for "stated, and it was not interrupted"
        // and NULL for "nobody said", and a reader that cannot tell those two apart is the reader F181 was about.
        assert.equal(got[9] === 0, want.interrupted === false, `a stated \`false\` of seq ${want.seq}`)
    }
})

test('AND ITS TOOL CALLS, with the name and the arguments', () => {
    const { calls } = foldedRows()
    const wanted = expectedRows().filter((row) => row.kind === 'tool_call')
    assert.equal(calls.length, wanted.length, 'this store and the fixture disagree on how many tool calls there are')
    for (const want of wanted) {
        // THE CALL ROW: 0 id, 1 call id, 2 name, 3 args, 4 the FULL length of the args, 5 seq.
        const got = calls.find((row) => row[1] === want.callId)
        assert.notEqual(got, undefined, `the fixture has a tool call ${want.callId} and this store does not`)
        assert.equal(got[2], want.name)
        assert.equal(got[3], want.args)
        assert.equal(got[4], want.args.length, 'and the full length of the arguments is beside the copy')
    }
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
    assert.ok(messages.some((row) => row.interrupted === false), 'and one that SAID it was not interrupted')
    // AND THE RULES THE FIRST VERSION OF THIS FIXTURE DID NOT COVER, each one a mutation that used to leave this
    // suite green: the reasoning join, the text join, the reasoning of a non-assistant, the NUL in a tool call, a
    // second ask-group, a string body, and the resolution of a record whose content is not where its type says.
    assert.ok(messages.some((row) => row.reasoning !== null && row.reasoning.includes('\n')), 'two reasoning blocks, joined by a newline')
    assert.ok(messages.some((row) => row.text === 'done!'), 'two text blocks, joined by nothing')
    assert.ok(messages.some((row) => row.role === 'user' && row.reasoning === null), 'a human message with a reasoning block, and no reasoning')
    assert.ok(rows.some((row) => row.kind === 'tool_call' && String(row.name).includes('\uFFFD')), 'a NUL in a tool call\'s name')
    assert.ok(new Set(rows.map((row) => row.exchange)).size > 1, 'more than one ask-group')
    assert.ok(messages.some((row) => row.text === 'summary of the above'), 'a string body, trimmed')
    assert.ok(messages.some((row) => row.role === 'assistant' && row.text === ''), 'a record whose content is not where its type says it is')
})
