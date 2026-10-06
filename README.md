# dsh-session-index

A derived SQLite index over **DeepSeek Harness session logs**, as a plugin: full-text search, listing, reading, and an
incremental rebuild — offered as a **service** and as **agent-facing tools**.

It is a Node program with a SQLite file. It imports **no dsh modules at all**: only `node:sqlite`,
`node:child_process`, `node:fs`, `node:os`, `node:path` and `node:url`. What it knows about dsh is dsh's session
*format*, which it reads.

## Why this exists

The harness already ships a SQLite FTS index (`@deepseek-ai/dsh-session-query-sqlite`) and agent tools that use it
(`@deepseek-ai/dsh-tool-session-query`). **We tried to use them and it broke a deployment**: enabling that index made
`api-session-controller` fail to start, its own code calling `provider.searchSessions`, and the cause was never
reproduced — a probe of the same profile on another port booted cleanly. The deployment left the harness index at
`openAt: never`, which also means the harness's five session tools have no backend to answer from.

So this package carries the capability instead. The history is in the parent repository's findings register (`F98`,
`F96`, `F99`, `F102`, `F103`), and it is written here so that a reader of this package alone knows why it is not just a
wrapper around the thing that already exists.

## Install

```bash
dsh plugin --profile <profile> add github:johnlam1968/dsh-session-index
```

or as a dependency plus a bundle entry in the profile's `package.json`:

```json
{ "dependencies": { "dsh-session-index": "github:johnlam1968/dsh-session-index" },
  "dsh": { "profile": { "bundles": ["...", "dsh-session-index"] } } }
```

The row it inserts is `session-index`, which provides the service and registers the tools:

```yaml
- insert:
    - id: session-index
      name: 'dsh-session-index'
```

`Config`: `path` (the store; default `$DSH_HOME/session-index.db`), `sessionsDir` (default `$DSH_HOME/sessions`),
`tokenizer` (`trigram` | `unicode61` | `none`).

## The service

`ctx.localSessionIndex` — the capability without the schema: no SQL, no table names and no file layout cross the
boundary, so a consumer cannot come to depend on a store that is derived and free to change.

| method | what it answers |
|---|---|
| `search(term, {limit})` | sessions whose **text, reasoning, tool results or tool-call arguments** match |
| `find(term, {limit})` | sessions whose **title, id or working directory** match |
| `list({cwd, search, limit})` | what the store holds |
| `read(id, {kinds, lastMessages, offset, messageChars})` | one session's conversation, from its log |
| `meta()` | what the store says about itself: `text_indexed`, `search_mode`, `tokenizer`, `fts_rows`, `sessions` |
| `refresh({timeoutMs})` | an incremental rebuild in a **child process** |
| `build({withText, incremental, tokenizer})` | a rebuild **in this process** — for a script or a migration |
| `row(id)` | one stored row, for a caller that wants the file behind an id |

## The agent-facing tools

| tool | the question it answers |
|---|---|
| `session_index_list` | what is in the store: ids, titles, working directories, size, and whether a row is a SUBAGENT run. `subagents: include\|exclude\|only` filters them (measured: 318 of 499 rows are worker runs), and the answer always reports the mixture |
| `session_index_read` | one session's conversation, as it was said — with how much session there is and what was left out |
| `session_index_search` | where a phrase appears, and **which mechanism** answered |
| `session_index_refresh` | bring the store current, incrementally, in a child process |

### What they deliberately do NOT do

**No measurement semantics.** The observer plugin that consumes this one composes the *subject a judgement would see*
and marks the *OBSERVE allow-list*; both are facts about measuring a session, not about storing one. A session library
that carried them would be useless to a deployment that measures nothing. Concretely, this package has:

* no `state`/composer output, no judge's character budget;
* no allow-list, no "which sessions will be measured";
* no readings, no probabilities, no trace.

### Where the tools came from, and what is next

`list` and `read` were added when this plugin was split out of the observer, because a session library that cannot be
asked what it holds, or what a session said, is not usable on its own. Remarks for the next reader:

* **`session_index_stats`** is not a tool; `meta()` carries the same facts and `list` reports the counts. Add it only
  if a model has a question that neither answers.
* **Live sessions**: `read` reads the *persisted* log, and `list` reads the *index*, so a session still being written
  is only as current as the last build. `refresh` is the way to close that gap, and a `session_index_read` of a *live*
  in-memory session would need the harness's `sessionQuery` service — a dsh dependency this package deliberately does
  not take.
* **Other harnesses** (pi, minimax-code, zeroclaw, Hermes) write their own formats; the reader is dsh-format-specific
  and a second format is a second reader, not a flag.
* **The service is live but NOT CATALOGUED**, measured after the first real deployment: `cordis_inspect_query
  { platform: 'host', provider: 'Service', method: 'listService' }` lists the harness's own services (including
  `sessionQuery`) and does not list `localSessionIndex`, while `listTools` does list all four of this plugin's tools.
  The catalogue appears to hold services that carry a declared contract, and this one is provided as a plain object --
  a consumer can still inject it by name, but it is not discoverable or typed through the catalogue. Declaring it
  properly is the first item for the next reader.

## The store

Derived and droppable: a refresh recreates it from the session logs, and nothing in it is a source of truth. Tables:
`sessions`, `messages`, `tool_calls`, `tool_results`, `search_fts` (the FTS5 mirror), `meta` (the mode receipts).

**The tokenizer decides what a query MEANS**, so it is chosen and recorded in `meta`:

| tokenizer | `MATCH` finds | store size (measured: 499 sessions, 121.5 MB of text) |
|---|---|---|
| `trigram` (**default**) | substrings, exactly like a `LIKE` scan | 617.8 MB |
| `unicode61` | words and phrases only — `oice-prox` finds nothing | 353.3 MB |
| `none` (`build --no-fts`) | the scan over the stored tables | 154.7 MB |

A query **shorter than three characters** is answered by the scan and reports `like`, because three is the smallest run
a trigram index stores.

## Measured costs (one host, 499 sessions)

| what | cost |
|---|---|
| full build with text and the trigram mirror | 562 s, 617.8 MB, 91,158 mirrored rows |
| refresh of ONE living 33 MB session | **2.7 s** — refold 2.2 s (decode 0.9, fold 1.0, insert 0.4), mirror **0.4 s** (append-only) |
| search | 4–13 ms (mirror) against 242 ms (scan) |

Two fixes are recorded in the numbers rather than in prose: writing a refolded session in **one transaction** took the
insert phase from 41.3 s to 0.3 s, and maintaining the FTS mirror **per session** took a one-session refresh from
110 s to 56 s. The mirror step is now **APPEND-ONLY**, and the remedy this README used to name was retired by measurement
(`F106`): `DELETE … WHERE session_id = ?` on a 15,037-row session costs **4,087 ms**, deleting the same rows **by rowid**
costs **4,129 ms**, and the lookup a `session_id → rowid` map would replace costs **92 ms** — the seconds are FTS5's
trigram index work, not the search for the rows. So the work was removed instead of the lookup: `search_fts` carries
`seq`, `mirror_state(session_id, high_water)` records how far each session's mirror was built, and maintenance appends
**only the rows above that mark** — which a DSH log makes safe, because it only ever grows. A session with no receipt,
a log that shrank, or a row with no `seq` is **replaced** rather than guessed at, and the build reports which path ran
(`ftsAppended` / `ftsReplaced` / `ftsUnchanged`). `SCHEMA_VERSION` 4 costs one full rebuild, once.

## Tests

```bash
npm test        # 28 tests: the store, the refresh, the plugin, the four tools
npm run coverage
```

## License

MIT
