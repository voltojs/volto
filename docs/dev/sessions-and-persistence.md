---
title: Sessions and persistence
status: current
source:
  - packages/core/src
  - packages/stores
  - packages/runtimes/node/src
  - packages/sdk/src
  - apps/gateway/src
verified: 2026-11-13
supersedes:
  - docs/archive/superpowers/specs/2026-09-03-pluggable-session-storage-design.md
  - docs/archive/superpowers/specs/2026-09-04-transcript-event-log-v2-design.md
  - docs/archive/superpowers/specs/2026-09-07-web-session-memory-only-design.md
  - docs/archive/superpowers/specs/2026-10-20-session-retrieval-fork-design.md
  - docs/archive/superpowers/specs/2026-10-20-session-export-design.md
  - docs/archive/superpowers/specs/2026-10-30-session-title-design.md
  - docs/archive/superpowers/specs/2026-11-06-turn-file-diff-design.md
  - docs/archive/superpowers/specs/2026-11-09-session-pinning-design.md
---

# Sessions and persistence

Two persistence seams share the word "session". `SessionStore` is a whole-`AgentState`
snapshot store for human-in-the-loop (HITL) checkpoint/resume. `TranscriptStore` /
`TranscriptReader` are the append-only event log a session is replayed from. Export,
fork, search, titles and pins are views or host concerns over those two.

The code is the source of truth; where a spec disagrees, this page follows the code
and names the reversal.

## Scope and where it sits

- Core: `ports.ts` (`SessionStore`, `SessionSnapshot`, `TranscriptStore`,
  `TranscriptReader`, `TranscriptEventMap`, `TranscriptEventInput`,
  `TranscriptEvent`) and `transcript-projection.ts`.
- Stores: `stores/{memory,file,sqlite,postgres}` implement `SessionStore`;
  `stores/jsonl` deliberately does **not** (package header) — a durable transcript and
  a resumable execution snapshot answer different questions.
- Wiring and hosts: `runtimes/node/src/{runner,transcript-recorder}.ts` produce events;
  `sdk/src/create-agent.ts` (`sessionStore`, `chatStore`, `chatSessionId`, `chatMeta`,
  `initialTurn`, `initialStep`, `initialMessages`, `initialQueuedInputs`,
  `pinnedMessageIds`) and `transcript-reader.ts` consume and project them;
  `apps/gateway/src/{sessions,server,session-fork,session-store-factory}.ts` own the
  JSONL directory, routes, titles and sidebar layout.

Dependency direction is `core ← stores-* ← sdk ← apps/*`; stores consume only core
interface types and projections stay in core. Attachment bytes, plan contents, memory/RAG
and SSE framing are out of scope.

## Current behavior

### Transcript: one append-only event log

A stored event is `TranscriptEventInput` (`time`, `type`, `data`, optional `turn` and
`step`) plus a store-assigned `seq`. `seq` is absent from the input because the Runner
is recreated per turn and parallel appends exist; only the store's per-file queue makes
it monotonic. `TranscriptEventMap` is a closed TypeScript union covering lifecycle
(`session_meta`, `turn_start`, `turn_end`), model calls (`model_call_start`,
`model_request`, `assistant_message`, `model_error`, `model_retry`), tools (`tool_call`,
`tool_result`, `approval_asked`, `approval_decision`), context (`request_header`,
`context_assembled`, `compaction`, `tool_results_pruned`, `context_reminder`,
`todoListUpdated`), input (`user_message`, four `steering_*` events, `file_changed`),
sub-agents (`subagent_started`, `subagent_finished`, the drop/downgrade/tier records)
and terminal markers (`budget_exceeded`, `error`).

Recording: `createTranscriptRecorder` stamps `time`/`turn`/`step` once, streams that
object to the `EventSink` when present, and buffers it for the store (no-op with
neither). `flush()` chains writes and never rejects; a failed batch is dropped, not
retried. The Runner flushes fire-and-forget after turn open, steering mutations, each
model call and each tool batch, and **awaits** at the end of `run()`/`resume()`.

`runner.ts` records `turn_start`/`user_message` before model I/O, `assistant_message`
from `model_done`, `tool_call`/`tool_result` from sink events (including
`displayMetadata`, which makes per-turn diffs replayable, and `content` kept as
`string | ToolResultBlock[]` — blocks are validated, never join-flattened), `approval_asked`/
`approval_decision` around the gate, and `turn_end` in the shared `finally`. The SDK
appends one `session_meta` at construction when `chatStore`, `chatSessionId` and
`chatMeta` exist, and writes fallback `turn_end`/`error` for failures before a Runner
exists (`recordTurnEndError`, `recordTurnError`); none may fail a turn. A sub-agent gets
its own `chatSessionId`, a `session_meta` with `parentSessionId`/`delegationDepth`/
`origin: "subagent"`, and a throwaway in-memory `SessionStore` for HITL, so child
approvals are not durable.

Storage (`stores/jsonl/src/index.ts`): `SCHEMA_VERSION = 3`; one `<id>.jsonl` per
session, one `{ version: 3, sessionId, event }` line per event, one subdirectory per
workspace named by `encodeWorkspaceName` (every non-alphanumeric character → `-`,
deliberately lossy); unbound sessions at the root. Writes resolve to an existing file
wherever it lives (`resolveWritePath`). `readEvents` → `[]` and `readSession` →
`undefined` for unknown ids; a torn line is skipped; a version mismatch throws
`TranscriptFormatError`; `listSessions` returns `{ records, skipped }` and
`GET /sessions/:id` maps the error to **410**.

Projection (`transcript-projection.ts`, pure): `projectMessageEntries` →
`ProjectedMessage[]`, `projectMessages` → the `Message[]` used as `initialMessages` on
rebuild. It mirrors the reducer, not wire order: results flush in the assistant call's
`pendingTools` order (`roster`, re-ordered by approvals), not by `orderInBatch`;
denials synthesize an error result; steering renders at `steering_delivered` (with a
cross-turn anchor rule) and undelivered entries drop; a mid-batch turn end gets the
same interrupted results as `reducer.ts`; compaction with `replacedIds`/`summaryId`
attempts the reducer's write-back. The message-producing events (`user_message`,
`assistant_message`, `tool_result`) carry the reducer's durable `messageId`, so a later
compaction's `replacedIds` can match on a cold rebuild; a legacy log without one gets a
synthetic `proj-N` id. System prompts and seeds are not projected (the host re-injects).

Reads: `readConversation`/`readTrajectory` (`sdk/src/transcript-reader.ts`) call
`buildTurnRecords` + `toConversationView`/`toTrajectoryView`. The gateway serves
`GET /sessions/:id` (conversation, todos, queued steering, context usage), `/trajectory`
and `/events`; `?tail=1` adds `unfinishedTurnTail` plus the live `running` flag — the
flag is the truth, a bare tail can be a crash.

### Store implementations

| Package | Role | Durability notes |
| --- | --- | --- |
| `@voltojs/stores/memory` | `SessionStore` | `Map`; returns the same object reference |
| `@voltojs/stores/file` | `SessionStore` | one JSON file per id, tmp + `rename` |
| `@voltojs/store-sqlite` | `SessionStore` | `sessions` table, JSON state, WAL, upsert |
| `@voltojs/store-postgres` | `SessionStore` | `JSONB`, lazily created table, pool |
| `@voltojs/stores/jsonl` | transcript | append-only JSONL, per-file queue, delete tombstones |

The first four share `runStoreContractTests`
(`packages/core/src/testing/store-contract.ts`): save/load round-trip, unknown id →
`undefined`, `list` returns all, same-id save overwrites, and `AgentState` structure
(messages, `pendingTools`, `pendingApprovalTool`, `readFiles`, counters) survives
serialization. `@voltojs/stores/jsonl` has its own event-log, search, concurrency, scope and
tombstone tests.

`session-store-factory.ts` picks SQLite at `~/.volto/db/sessions.db` when
`better-sqlite3` loads, else the file store at `~/.volto/sessions-store/`. A fallback
never reads, migrates or deletes the SQLite file; `VOLTO_SESSION_STORE=file` forces it.
Transcripts always go to `~/.volto/sessions/` (`server.ts`), normally
`<workspace>/<id>.jsonl`; separate from checkpoints.

Search is a linear scan in `searchSessions`: title plus `user_message`/
`assistant_message` text only (never tool output), NFKC + lowercase,
substring matching, default limit 20 (max 50), snippet default 160 characters
(40–500), sorted `updatedAt` descending with `sessionId` as a stable tie-break.
Sub-agent sessions are excluded; `projectId` is optional. `GET /sessions?q=` adds
`snippet` and `unreadableSessions`.

Delete is host-level: `DELETE /sessions/:id` reads the record (404 if missing), calls
`deleteSession` (tombstone + queued unlink, so a racing append cannot resurrect the
file), then drops attachments, plan and browser page. `SessionStore` rows are **not**
removed — the port has no delete.

### Checkpoint

`SessionSnapshot` is `{ id, state: AgentState, createdAt }`; in practice `state` is the
full `ReducerState` (SDK and debugger cast), including internals such as
`_toolResultBuffer`; the port types it as `AgentState` deliberately.

`runner.ts` writes `sessionId` (canonical, for `resume()`) and `${sessionId}#${n}`
(history, for the time-travel debugger) when the reducer emits `checkpoint` (the
`request_approval` handler, before the gate is awaited) and at the end of `runLoop()`
when `status === "done"`. Both `save` calls are awaited; unlike transcript writes, a
failing checkpoint propagates and fails the turn.

`n` starts at `turn * 1000` (`CHECKPOINTS_PER_TURN`), not at 0: the Runner is rebuilt for
every turn, so a per-instance counter counted from 0 and rewrote `<sessionId>#1` each turn,
losing the earlier history. A Runner built without `turn` keeps the old within-Runner
numbering.

Pins live on `ReducerState` (`pinnedMessageIds`), so a HITL checkpoint carries them; a cold
rebuild from the transcript does not, and the host re-seeds the first turn with the
`CreateAgentOptions.pinnedMessageIds` option instead.

The HITL `sessionId` is per turn (`"session-" + idPort.next()`); sub-agent Runners get
`"sub-" + idPort.next()` and an in-memory store. `createTimeTravelDebugger`
(`sdk/src/debugger.ts`) lists the `<id>#` keys, rewinds with `load`, replays with pure
`step` and diffs with `diffState`; continuing from a terminal `done` checkpoint
requires `resetTurnForNextInput`. A HITL pause is not a turn end: `recordTurnEnd()`
returns early while `status === "waiting_for_approval"`, leaving the closing `turn_end`
to the `resume()` that completes the turn.

### Resume and rebuild

1. **HITL resume** (`agent.resume(sessionId, decision)`): try
   `lastRunner.resume(...)` in-process; on failure `sessionStore.load`, require
   `status === "waiting_for_approval"` and `pendingApprovalTool`, build a fresh Runner
   with `initialState`, the same `chatStore`/`chatSessionId`, the current turn and the
   host's `initialStep`, re-record `approval_asked` if absent, feed `approval_decision`,
   rerun. `Runner.resume` validates outside the try/finally and brackets the resumed
   turn with `turn_end` + flush.
2. **Rebuild from transcript** (the gateway's normal path after a config change or
   restart): no `SessionStore`. `sessions.ts` reads events, projects history with
   `projectMessages`, folds the steering queue with `pendingSteeredMessages`, and seeds
   `initialMessages`, `initialQueuedInputs` (by reference), `initialTurn`, `initialStep`,
   `initialContextLayers` and the scoped `chatStore`/`chatSessionId`/`chatMeta`. The SDK
   cannot recover turn/step: a snapshot carries neither and `TranscriptStore` is
   write-only.
3. **Mid-turn reconnect**: `GET /sessions/:id/events?tail=1` returns
   `unfinishedTurnTail(events)` plus the live `running` flag; the memory-only web store
   refetches `GET /sessions` and `GET /sessions/:id` after a reload.

The legacy `POST /resume` uses the shared no-session agent; the web flow settles
approvals in-process through `ApprovalGate`.

### Export

`GET /sessions/:id/export?format=md|jsonl` is read-only, writes no server files, returns
404/400 for an unknown session/format, and sets `Content-Disposition: attachment` with a
sanitized filename. `md` (`renderSessionMarkdown`) renders title, bindings,
created/updated times, then per `turn_start` a `## Turn N` section with user/assistant
text, fenced tool-call JSON and tool-result summaries truncated to 200 code points;
reasoning is omitted and an empty title reads `Untitled session`. `jsonl`
(`renderSessionJsonl`) emits one `{ version: 3, sessionId, event }` object per event,
matching the store's line shape. Attachments are refs only; bytes are never exported.
The export route comment still says "v2 JSONL"; renderer and store are v3.

### Fork

`POST /sessions/:id/fork` → `forkSession`. The source is read-only. The route rejects a
running source (409), a sub-agent source (400) and an unknown source (404);
`forkSession` also rejects an existing target id (500), because the JSONL write path
would append onto it.

The cut is always a completed `turn_end`: `throughTurn` selects that turn's last
`turn_end`, falling back to the latest completed turn before it when the requested turn
never finished; `throughSeq` selects the last `turn_end` with `seq <= throughSeq`;
neither selects the last completed turn; no completed turn at all is 400. The two
options are mutually exclusive. The copied prefix keeps `time`/`turn`/`step`/`data`;
the new store reassigns `seq`. Every `session_meta` in the prefix is rewritten to the
new title and `parentSessionId`, and every `origin` is removed (one meta is prepended
when none existed) — rewriting only the first would let a later rename restore the
source title. Default title is the source title plus the localized
`server.fork.branchSuffix` (`" (branch)"` / `"（分支）"`), or `server.fork.branchName`
when untitled. Attachments referenced by the prefix are copied id-for-id
(`collectAttachmentIds` walks user/assistant/tool_result/compaction content); missing or
failed copies warn and leave the fork durable. The plan is copied when the source has a
project path. No checkpoint, live agent state or sub-agent transcript is copied.

### Session metadata: titles, pins, per-turn file changes

Titles are server-owned (`session-title.ts`, `sessions.ts`). `prepareHeuristicTitle`
derives from the first user message (transcript first, current message as fallback),
writes `heuristic` capped at 60 code points, then starts `generateModelTitle` alongside
the turn (not after `turn_end`) when a title model is configured: 15 s abort and a
sanitizer that refuses replies over 40 code points, multi-line output, markdown or
leaked tool-call markup. Titles append `session_meta`; the store folds metas field by
field, last-wins. `TITLE_SOURCE_RANK` is `user: 3 > model: 2 > heuristic: 1`; a
successful write pushes the merged meta to the live channel, and a lower-ranked write
returns `outranked` (`PATCH` → 409). `PATCH /sessions/:id` accepts `source`
`user`|`model`|`heuristic` (default `user`) and a 1–200 character title.

Pins are not session data: `config/sidebar-state.ts` stores `pinnedSessionIds`, project
order, sort modes and collapse flags in `config.json` under `sidebar`, served by
`GET/PUT /sidebar-state`. Arrays cap at 500, ids at 200 characters, duplicates collapse,
unknown ids are kept and filtered at render time, and a corrupt document degrades to
defaults. Fork/export never carries a pin, and deleting a session leaves a stale id.

Per-turn file changes are not checkpoints: a write tool captures a unified diff into
`ToolResult.displayMetadata.fileChange` (`unified-diff.ts`, `MAX_DIFF_CHARS = 20_000`),
the reducer persists `displayMetadata` with `tool_result`, and
`extractFileChange`/`view-projection.ts` expose it as `ConversationToolCall.fileChange`.
The web aggregates per turn. Reload, fork and JSONL export keep the exact diff without
git; Markdown export only shows the tool summary.

## The SessionStore contract

```ts
export interface SessionSnapshot {
  id: string;
  state: AgentState;
  createdAt: number;
}

export interface SessionStore {
  save(snapshot: SessionSnapshot): Promise<void>;
  load(id: string): Promise<SessionSnapshot | undefined>;
  list(): Promise<SessionSnapshot[]>;
}
```

- `save` is an upsert keyed by `snapshot.id`; `load` of an unknown id resolves
  `undefined` (not an error or empty snapshot); `list` returns every snapshot with
  **unspecified order** (the debugger sorts, callers filter by key).
- State must survive JSON serialization: arrays, `pendingApprovalTool`, `readFiles` and
  counters round-trip unchanged (`runStoreContractTests`).
- There is no delete, range/prefix query or ordering; history is key naming
  (`<sessionId>#<n>`), not a port feature.

Not promised: memory returns the same object reference (post-`save` mutation is visible
to `load`), file/sqlite/postgres return copies; file `list` skips unreadable JSON; only
the file store replaces atomically itself (tmp + rename).

## Invariants and boundaries

| Surface | Written when | Failure semantics |
| --- | --- | --- |
| Transcript events | recorder flush (open/model call/batch/steering), awaited at turn end | swallowed; a lost batch never fails the turn |
| `session_meta` at construction | agent construction | fire-and-forget (`bestEffortAppend`) |
| HITL checkpoint | `request_approval` before the gate, and `done` | awaited; failure propagates |
| Checkpoint history key | same moments | awaited; same failure semantics |
| Title | first turn before streaming; model title when configured | swallowed; never surfaces in the turn |
| Pin/layout | `PUT /sidebar-state` | client is optimistic and silent on failure |
| Attachment/plan | upload / `save_plan`; copied on fork | fork warns and continues |
| Per-turn file diff | inside the `tool_result` event | best-effort, like the transcript |

- A transcript is append-only and `seq` is store-assigned, monotonic and contiguous as
  written from 0. Deleting a session unlinks the file; a tombstone stops a racing
  append recreating it. A dropped torn line can leave a gap in the parsed sequence.
- The format is versioned with no migration: version 1/2 files are rejected with
  `TranscriptFormatError`, and `listSessions` reports them in `skipped`. Store packages
  do I/O only; shape conversion, ordering and replay live in core's projections.
- A transcript read never reconstructs a `SessionStore` snapshot and vice versa: a
  resumed HITL turn continues from the checkpoint, a rebuilt agent from projected
  messages. `Runner.resume`/`createAgent.resume` reject a snapshot that is not
  `waiting_for_approval` or lacks `pendingApprovalTool`.
- No checkpoint retention: every completed turn writes at least one row and the port
  has no delete. Transcripts also grow without file compaction (the `compaction` event
  is context compaction).
- Transcripts contain full user text and tool results; search excludes tool output, but
  export and the raw events route do not redact it. Attachment bytes stay out (refs).

Current gaps and inconsistencies:

- A compaction event whose `replacedIds` match nothing in the projection — a legacy log,
  or a span containing only synthesized messages such as a denial — is skipped, so a cold
  rebuild projects the pre-compaction messages despite the event's `summaryId` /
  `summaryText`.
- `tool_results_pruned` is log-only by design, so a cold rebuild keeps unpruned content
  until the Runner prunes again; state and projection can disagree until then.
- `renderSessionJsonl` documents "events[0] is the session_meta" but does not enforce
  it; a `createIfMissing` title write appends a meta after earlier events.
- `TranscriptStore` has no read half; `asTranscriptReader` is a jsonl-specific adapter,
  not a core bridge.

## Decisions and rejected alternatives (with dates)

| Date | Current decision | Rejected alternative / reversal |
| --- | --- | --- |
| 2026-09-03 | Two ports: `SessionStore` for HITL snapshots, `TranscriptStore` for the chat record. | One store for both jobs; jsonl explicitly is not a `SessionStore`. |
| 2026-09-04 | One append-only event log; store-assigned `seq`; pure projection rebuilds `Message[]`. | v1 meta/message/error/trajectory rows, per-chunk persistence, store-side projection, `ignorable`, synthesized crash closers. |
| 2026-09-04 | Version mismatch is refused, no migration. | Silent skip/migration; `listSessions` softens it only for listing (`skipped`). |
| 2026-09-07 | Web keeps sessions in memory; the server transcript is the single source of truth. | localStorage persistence, offline history, client-side title derivation. |
| 2026-10-20 | Search is a linear scan over title + user/assistant text. | Indexed/FTS search; searching tool output. |
| 2026-10-20 | Rewind is a fork at a completed `turn_end`, never in-place truncation. | Destructive truncation; "branch + delete source" remains the recipe. |
| 2026-10-20 | Export is Markdown plus store-shaped JSONL, read-only. | Batch export, attachment binaries, PDF/HTML, import API. |
| 2026-10-30 | Server-owned titles in `session_meta`, ranked `user > model > heuristic`. | Client-derived titles; routing tiers as the title model; regenerate UI. |
| 2026-11-06 | Diffs come from `displayMetadata.fileChange` on the tool result. | `git diff` (wrong scope, not a repo) and per-turn workspace snapshots. |
| 2026-11-09 | Pins/sidebar layout live in `config.json`, not the transcript. | `pinned` in `ChatSessionMeta`; forking/exporting the pin. |

Reversals visible in the code:

- Compaction now writes back (`compaction_applied` in `reducer.ts`) and the projection
  tries to replay it, though the 2026-09-04 spec declared compaction log-only.
- Tool-batch order mirrors the reducer's `pendingTools` roster, not a
  `(turn, step, orderInBatch)` sort; `request_header` dedupe is cross-turn
  (`headerHashState`), not the accepted per-turn duplicate.
- Fork rewrites **every** `session_meta`, not only the first.
- Titles: heuristic cap 60 (not 200), model titles over 40 code points refused (not
  clipped), generation alongside the turn rather than after `turn_end`; export is v3,
  not v2.

## How to change it

Affected gates (never the whole repo by default):

```bash
pnpm turbo run typecheck lint test --filter @voltojs/core --filter @voltojs/runtime-node \
  --filter @voltojs/sdk --filter @voltojs/stores/jsonl --filter @voltojs/gateway
```

Add `@voltojs/stores/memory`, `-file`, `-sqlite`, `-postgres` when the contract changes.

Targeted suites: `packages/core/src/__tests__/{transcript-projection,transcript-types,compaction-writeback,steering-rebuild,view-projection-*}`,
`packages/runtimes/node/src/__tests__/{transcript-recorder,transcript-events,transcript-image,transcript-structured,runner-time-travel,runner-hitl}`,
`packages/sdk/src/__tests__/{resume,transcript-orchestration}`; `packages/stores/*/src/__tests__/store.test.ts`
(the four contract suites) plus jsonl `{event-log,search,scope,concurrency,delete-tombstone,delete-during-stream}`;
and `apps/gateway/src/__tests__/{session-fork,session-title-*,sidebar-state*,session-rebuild,chat-transcript-persistence}`.

Regression points:

1. **Projection equivalence.** `projectMessages(events)` must equal the reducer's
   `state.messages` for the same sequence: single tool, parallel tools completing out
   of order, mid-turn steering, denied approval, a turn ending mid-batch, compaction.
2. **`seq` and version.** Adding/reordering events must not change store-assigned
   `seq`; a line-shape change needs one `SCHEMA_VERSION` bump plus matching
   `renderSessionJsonl` and export tests.
3. **Edge validation and failure asymmetry.** Keep rejecting non-`waiting_for_approval`
   snapshots and missing `pendingApprovalTool`; a throwing
   `TranscriptStore.appendEvents` must not fail a turn, while a throwing
   `SessionStore.save` must.
4. **Search scope.** Keep excluding tool output and sub-agent sessions; widening it
   changes the privacy boundary.
5. **Fork invariants.** The cut lands on a `turn_end`, the target id must not exist,
   every meta is rewritten, the source is untouched.
6. **Title ranking.** New writers go through `writeSessionTitle`; bypassing it
   reintroduces the client-side race the server ranking removed.

When adding an event: extend `TranscriptEventMap`, record it from the Runner/SDK/host,
decide whether `projectMessageEntries` folds or ignores it, update `view-projection.ts`
if the UI needs it, and add a projection-equivalence case. When adding a store:
implement `SessionStore`, call `runStoreContractTests`, and document non-port behavior
(ordering, aliasing, atomicity) in the package.

## Further reading

- [Transcript event log v2](../archive/superpowers/specs/2026-09-04-transcript-event-log-v2-design.md) — event sourcing; details superseded (v3, compaction write-back, roster ordering).
- [Pluggable session storage](../archive/superpowers/specs/2026-09-03-pluggable-session-storage-design.md) — why `chatStore` is wired inside `createAgent()`.
- [Web session memory only](../archive/superpowers/specs/2026-09-07-web-session-memory-only-design.md) — the client-side half of "the transcript is the source of truth".
- [Session retrieval and fork](../archive/superpowers/specs/2026-10-20-session-retrieval-fork-design.md) — search, turn-boundary forks, branch-style rewind.
- [Session export](../archive/superpowers/specs/2026-10-20-session-export-design.md) — formats and the read-only HTTP contract.
- [Session titles](../archive/superpowers/specs/2026-10-30-session-title-design.md) — `titleSource` ranking and failure-as-no-op.
- [Turn file diff](../archive/superpowers/specs/2026-11-06-turn-file-diff-design.md) — diffs via `displayMetadata`, not git.
- [Session pinning](../archive/superpowers/specs/2026-11-09-session-pinning-design.md) — pins as `config.json` view state.
- [Store implementations](../../packages/stores) and [ports](../../packages/core/src/ports.ts).
