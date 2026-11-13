---
title: Observability and cost
status: current
source:
  - packages/core/src
  - packages/sdk/src
  - packages/runtimes/node/src
  - apps/gateway/src
  - apps/web
  - packages/eval/src
verified: 2026-11-13
supersedes:
  - docs/archive/superpowers/specs/2026-09-04-transcript-event-log-v2-design.md
  - docs/archive/superpowers/specs/2026-09-04-view-projection-consolidation-design.md
  - docs/archive/superpowers/specs/2026-09-05-web-trajectory-view-design.md
  - docs/archive/superpowers/specs/2026-09-06-context-usage-meter-design.md
  - docs/archive/superpowers/specs/2026-09-07-context-usage-precision-design.md
  - docs/archive/superpowers/specs/2026-09-11-context-reminder-audit-design.md
  - docs/archive/superpowers/specs/2026-09-26-turn-token-usage-design.md
  - docs/archive/superpowers/specs/2026-10-23-tokenizer-calibration-design.md
  - docs/archive/superpowers/reports/2026-10-23-cache-hit-6td66cf8h.md
---

# Observability and cost

## Scope and where it sits

Three planes carry these names and must not be conflated (the last folds views and telemetry):

| Plane | Contract | Writer | Reader |
| --- | --- | --- | --- |
| Live stream | `EventSink.emit({ type, data })` in `packages/core/src/ports.ts` | reducer emits (`EmitEffect`), Runner, tools | gateway SSE, desktop IPC, hosts |
| Durable log | `TranscriptEventMap` / `TranscriptEventInput` in `ports.ts` | `createTranscriptRecorder`, SDK `bestEffortAppend` | stores, projections, export |
| Views / metrics | pure projections (`view-projection.ts`, `context-usage.ts`); `Telemetry` port | nobody (views); Runner (spans) | SDK facades, gateway, web; host backend (default no-op) |

```text
reducer --emit--> Runner.forwardEmit --+--> EventSink (raw)
                                      +--> recorder.record ({time,type,data,turn?,step?})
                                             +--> EventSink (stamped) +--> TranscriptStore
store --readEvents--> buildTurnRecords --> toConversationView / toTrajectoryView
                                       --> foldSnapshotEvent --> snapshotView
```

The Runner translates the reducer's raw vocabulary into the transcript vocabulary
(`forwardEmit` in `packages/runtimes/node/src/runner.ts`). Because of the task-r6 double
write, each stamped event is both persisted and emitted, so live and durable streams match
for everything with a transcript counterpart; the 2026-09-04 log spec kept `EventSink`
unchanged, and the code has reversed that (see the reversal note under Decisions). The
vocabulary is closed in `TranscriptEventMap`; everything outside it is diagnostic traffic.

## Current behavior (events, lifecycle, subscribers)

### The recorder

`createTranscriptRecorder` (`packages/runtimes/node/src/transcript-recorder.ts`) is the
single stamping point. `record(type, data, meta)` builds `{ time, type, data, turn, step? }`
once, passes that exact object to the optional `emit` callback, then buffers it for the
store. `time` comes from the injected Clock (`nowMs()`); callers that already read it pass
`meta.time` so `request_header`, `model_call_start` and `model_request` share one reading.
`emit` runs even when no store/session is configured, so a persistence-less host still gets
the live vocabulary. `flush()` is best-effort: store errors are swallowed and a failed batch
is not requeued. `seq` is assigned by the store (`appendEventBatch` in
`packages/stores/jsonl/src/index.ts` continues from the last line).

### Transcript vocabulary (31 types)

From `TranscriptEventMap` (`ports.ts`):

- Lifecycle and model: `session_meta`, `turn_start`, `turn_end`, `model_call_start`,
  `model_request`, `assistant_message`, `model_error`, `model_retry`.
- Tools and context: `tool_call`, `tool_result`, `approval_asked`, `approval_decision`,
  `request_header`, `context_assembled`, `compaction`, `tool_results_pruned`,
  `context_reminder`, `todoListUpdated`.
- Input, steering and sub-agents: `user_message`, `steering_queued`, `steering_delivered`,
  `steering_edited`, `steering_removed`, `file_changed`, `subagent_started`,
  `subagent_finished`, `subagent_tools_dropped`, `subagent_permission_downgraded`,
  `subagent_model_tier_unresolved`, `budget_exceeded`, `error`.

`ContextReminderKind` is a closed union (`permission_boundary`, `workflow_mode`,
`self_correction`, `loop_reminder`, `loop_intervention`, `retrieval`, `todo_list`,
`background_task`, `workspace`); a new kind is a type change, not a new event.

### Turn lifecycle

1. `createAgent` writes `session_meta` at construction via `bestEffortAppend`, outside the
   recorder — durable but not streamed. The gateway later emits a `session_meta` frame only
   for a title write (`writeSessionTitle` in `apps/gateway/src/sessions.ts`).
2. `Runner.run()` records `turn_start` and (for a `user_message` input) `user_message`,
   then flushes before model I/O so `GET /sessions/:id/events?tail=1` can rebuild an
   in-flight turn. A `steering_flush` turn records no `user_message`; its content rode
   `steering_queued` and is realized by `steering_delivered`.
3. Per model call (`runModelStream`): `request_header` (only on hash change),
   `model_call_start`, `context_assembled` (only with layer origins), `model_request`
   (every call), `model_retry` / `model_error` as needed, then `assistant_message` on
   `model_done` with content, `stopReason`, `usage`, `source`, `ttftMs`, `durationMs`.
   `model_call_start.headerHash` points at the last header.
4. Tools and approvals: `tool_call` when the reducer emits `tool_use_complete`;
   `tool_result` with `callId`, `name`, `content`, `isError`, `durationMs`,
   `displayMetadata`, `orderInBatch` (projections sort batches by
   `(turn, step, orderInBatch)`); `interpretEffects` records `approval_asked` before the
   gate promise and `approval_decision` (optional `reason`) after it.
5. Context and steering: `compaction` carries `replacedCount`, `summaryText`,
   `replacedIds`, `summaryId`, summarizer `usage` and ref-only `preservedImages`;
   `tool_results_pruned` carries sizes, saved tokens and the estimated cache reset; both
   invalidate the prompt anchor. Steering records are written from `forwardEmit` (queue
   membership is a reducer decision) and flushed immediately.
6. `turn_end` is written in the `finally` bracket, reason precedence
   `budget_exceeded` > `error` > `cancelled` > `done`. A HITL pause writes none; the resume
   that completes the turn writes one.

### Raw, non-transcript events

Passed straight to the sink without a stamp and never persisted: `text_delta`,
`reasoning_delta`, `tool_use_delta`; `usage_unavailable`, `tokenizer_calibration`,
`hook_error`, `preCompact_skipped`, `spill_failed`, `attachment_unavailable`, `cancelled`,
and the terminal `error` emit. Tools may push `displayMetadata.pendingEvents` through the
same sink; no bundled tool does, and `ask_user` emits to its construction-time sink. The
gateway uses the presence of `time` as its discriminator (`asTranscriptEvent` in
`sessions.ts`): unstamped events are dropped from `/events`, deltas are framed specially.
Legacy `/stream` and `/ws` (`apps/gateway/src/event-sinks.ts`) still expose the raw stream.

### Fan-out and reconnect

A sub-agent dispatch creates a child session with its own transcript; the parent records
`subagent_started` / `subagent_finished` (plus the dropped-tools, downgrade and unresolved-
tier events), while `tagEventSink` (`create-agent.ts`) adds `agentDepth`, `agentLabel` and
`childSessionId` to the child's stream so the gateway can route it. Parent brackets are
never tagged, and child usage stays in the dispatch result.

`sessions.ts` keeps one `EventMapper` and replay buffer per session. `frame()` turns the
three deltas into `delta` frames (never buffered or replayed) and every stamped event into
an `event` frame; `push()` buffers non-delta frames (default 200) and writes to the attached
response. `attach()` sends a comment, a fresh per-connection `connected` token, a 15 s
heartbeat, then replays frames newer than `Last-Event-ID`. One client per session; a
replacement connection settles pending approvals fail-closed as `connection-lost`.
`emitToSession` forwards out-of-band events (`ask_user`, synthetic approval brackets) with a
real timestamp, buffering but never persisting them. `GET /sessions/:id/events?tail=1`
returns only the unfinished turn plus `running`, merged before live frames.

Web subscribers (`apps/web/stores/chat-store.ts`) keep `events` and `deltas` separately;
`pushEvent` clears deltas on `assistant_message`; sub-agent buckets route by `agentDepth` /
`childSessionId`; desktop uses an IPC sink instead of SSE.

## Cost and token accounting (where numbers come from, known inaccuracies)

### Usage source and normalization

The only authoritative numbers come from `ModelEventUsage` on the provider stream. Adapters
normalize so `inputTokens + cacheReadTokens + cacheWriteTokens` is the full prompt:
`packages/providers/openai/src/stream-normalize.ts` maps DeepSeek
`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` and OpenAI
`prompt_tokens_details.cached_tokens` (`inputTokens` is the uncached remainder);
`packages/providers/pi-ai/src/stream-normalize.ts` sets `cacheReporting`
(`reported` / `not-reported` / `unsupported`) because pi-ai cannot distinguish "reported
zero" from "not reported" for implicit caches; the Anthropic adapter emits the buckets but
not `cacheReporting`, which the UI reads as reported. A request that asked for usage but got
none emits `usage_unavailable` as a raw event.

### Aggregation in the Runner

`accumulateUsage` (`runner.ts`), shared by the main loop and the compaction summarizer, adds
`totalUsageTokens(usage)` (cache included) to `cumulativeTokens` and either
`computeUsageCost(entry, usage)` (when `opts.pricing` has an entry for `stepContext.model`)
or `totalUsageTokens(usage)` to `cumulativeCost`; that token fallback is the documented
conflation compared against `maxCostDollars`. Budget checks run mid-stream on each `usage`
and in `checkBudgetLimits` for `maxCostDollars`, `maxTokensPerTurn` and `maxWallclockMs`;
exceeding one feeds `budget_exceeded` and closes the turn. The reducer separately adds
`model_done.usage` to `state.tokensUsed` for `tokenBudget`, so compaction summarizer usage
counts toward `maxTokensPerTurn` but not `tokenBudget`.

`computeUsageCost` / `totalUsageTokens` live in `packages/core/src/pricing.ts`: per-1M
prices; cache read/write use their dedicated rate when defined and **zero** otherwise.

### What reaches the user

- `TurnUsage` (`view-projection.ts`) is folded by `summariseTurnUsage` from every step's
  usage plus `compactionUsage`, attached to the turn's last assistant message. A usage-less
  call counts in `missingUsageCalls` (footnote) instead of zero; all-missing means no chip.
- Cache-hit rate (`apps/web/lib/turn-usage-model.ts`) is
  `cacheRead / (input + cacheRead + cacheWrite)`; `not-reported` / `unsupported` yield no
  percentage, and a zero prompt yields `—`. The denominator is the prompt, not `totalTokens`.
- `context-usage.ts` powers the ring: last provider usage is the anchor
  (`prompt = input + cacheRead + cacheWrite`, plus output), later content is estimated with
  the injected `Tokenizer`. Production uses `ContextUsageSnapshot` + `foldSnapshotEvent` +
  `snapshotView`; `ContextUsageFold` is the test oracle. `breakdown` is three independent
  estimates and intentionally does not sum to `projectedTokens`.
- The SDK `CostMeter` contributes nothing: `result()` is never called, so `cost_summary` is
  never emitted; it has no `model`, `record()` takes only input/output, and it is built once
  per agent. Dollar numbers exist only as Runner telemetry (`cost_usd`).

### Known inaccuracies

- **No in-repo host supplies pricing.** Gateway, web and desktop never pass `pricing` to
  `createAgent`, so `cost_usd` is never reported and no `$` figure appears in the UI.
  `maxDollarsPerTurn` is an SDK option; if enabled without a matching price entry, tokens
  are compared to dollars.
- **The context ring overestimates after compaction.** `foldSnapshotEvent` resets
  `pendingTokens` and `messageTokens` on `compaction` but leaves the anchor, so
  `projectedTokens` keeps the pre-compaction size until the next usage.
- **Estimates are heuristic.** `createHeuristicTokenizer` uses UTF-8 bytes / 4 with
  `BLOCK_OVERHEAD` / `ROLE_OVERHEAD` 4; `estimateImageTokens` uses area / 750. The per-model
  `tokenizerBytesPerToken` from the 2026-10-23 spec is not wired, and
  `tokenizer_calibration` is raw (the gateway drops it) — `/stream` only.
- **Sub-agent and verifier spend are separate.** They ride dispatch results, not the parent
  turn's `TurnUsage`; a trajectory-derived conversation total covers main-agent calls plus
  that session's compaction calls only.

## Debug surfaces

### Web

`apps/web/components/trajectory/` renders the audit ledger. `TrajectoryPanel` merges stored
rows (`GET /sessions/:id/trajectory`, lazily fetched, cached per session) with live rows from
`projectTrajectory` over the event and delta buffers. `mergeStoredAndLiveRows` dedupes by
stable row id (live wins), falls back to a content key for context/compaction rows whose ids
embed different `seq` values, then sorts by `startedAt`.

`TrajectoryDrawer` tabs come from `drawerTabsFor` (`lib/trajectory-view-model.ts`):
assistant → overview, request (the `model_request` manifest), output, thinking, timing;
tool/subagent → overview, input, output, schema, timing; context → overview, layers, schema;
user → overview, content; reminder/compaction → overview, text. Row kinds are `user`,
`context`, `assistant`, `tool`, `subagent`, `compaction`, `error`, `reminder`; context rows
derive from `request_header` (one per distinct hash), `compaction` and `context_reminder`.
Assistant rows show TTFT, duration and per-call usage; tool rows show arguments, result,
schema, duration and images. Sub-agent rows expose dropped tools, permission downgrades and
an unresolved routing tier, and drill into `SubagentTab` with `view: 'trajectory'`.
`ChatPanel`'s status bar adds `SessionStatsChip`, `ConversationUsageChip`, `ContextMeter` and
a per-answer `TurnUsageChip`.

### HTTP and SDK read surfaces

- `GET /sessions/:id/trajectory` — `readTrajectory`; `410` for a v1 transcript.
- `GET /sessions/:id/events` — raw persisted events; `?tail=1` adds `running`.
- `GET /sessions/:id` — projected conversation plus `contextUsage`, `todos` and
  `queuedMessages`; `GET /sessions/:id/export?format=md|jsonl` — the same log.
- `GET /stream`, `GET /ws` — legacy raw channels, unfiltered.
- `readConversation` / `readTrajectory` (`packages/sdk/src/transcript-reader.ts`) — thin
  facades over core projections.
- `createTimeTravelDebugger` (`packages/sdk/src/debugger.ts`) — lists `sessionId#seq`
  checkpoints, rewinds, steps once, diffs states. No in-repo host mounts it; covered by
  `debugger.test.ts` and `runner-time-travel.test.ts`.
- `packages/eval` records trajectories, not metrics: `createTrajectoryRecorder` captures
  inputs and expected `(state, effects)`, `replayTrajectory` compares them, and
  `volto-eval-replay` exits non-zero on divergence; `simulate.ts` supplies seeded ports.

## Invariants and boundaries

- **Events are not state.** Read `agent.getState()` or re-fetch for current state; a turn's
  verdict is `turn_end.reason`, never a tally of `tool_result`s.
- **One writer per concern.** Runner/recorder write the transcript; the gateway writes only
  titles to `chatStore`; projections are pure and never mutate the log.
- **Persistence is best-effort.** A store failure degrades to live-only and never fails a
  turn. `EventSink.emit` is synchronous and unguarded — host sinks must not throw.
- **The vocabulary is closed.** A new transcript event needs a `TranscriptEventMap` entry;
  a raw diagnostic event is never durable and `/events` drops it. Clients ignore unknown
  types. Ordering is per session (`seq` durable, emission live); `delta` frames can be lost
  and are healed by the next authoritative event.
- **Purity and boundaries.** Time, ids and token counts come from ports; views are
  browser-safe. Cost arithmetic enforces nothing — budgets live in `accumulateUsage` /
  `checkBudgetLimits` and `tokenBudget`. `createStreamChannel` has no backpressure: it
  queues until polled, and `res.write`'s return value is ignored.

## Decisions and rejected alternatives (with dates)

- **2026-09-04 — one append-only event log, one shared read projection.** `Message[]` is
  projected, not stored; `buildTurnRecords` is the only event parser and
  `toConversationView` / `toTrajectoryView` are shallow core derivations with SDK facades.
  Rejected: a parallel `message` row; v1 migration (v1 files answer `410`); per-chunk
  persistence (aggregate per call); an earlier design's `ignorable` flag (no out-of-repo writers);
  separate live/history projections; a read-side port fused with `TranscriptStore`;
  projecting in web. `seq` is store-assigned; sub-agents get their own session and file;
  `request_header` is written only on hash change (the code later added the cross-turn
  `headerHashState` holder to also dedupe the per-turn duplicate the spec accepted). The
  spec also called `compaction` a pure record; the 2026-09-15 write-back plan reversed that,
  so the event now carries `replacedIds` / `summaryId` / `usage` and the reducer rewrites
  the surface.
- **2026-09-05 — trajectory is a row list plus a detail drawer.** Rejected: timeline
  overview, filters/search, virtual scrolling, a recursive sub-agent tree. Dual sourcing
  (server rows + live projection, live wins) keeps a reload mid-turn from losing the row.
- **2026-09-06 / 2026-09-07 — context usage is anchor + estimate, not one tokenizer.**
  Rejected: a single absolute estimate; a residual "three parts must sum" breakdown
  (reverted to independent estimates); reserving output in the ring's denominator; shipping
  the full fold (the numbers-only snapshot replaced it). Adapters were normalized so `input`
  means uncached prompt, fixing CostMeter's double-priced cache tokens.
- **2026-09-11 — dynamic injections are auditable but never enter the chat feed.**
  `context_reminder` is one shell with a closed `kind` union; `compaction` keeps its own
  event. Rejected: open `source:{kind,form}` tags and unknown-kind fallback; folding
  compaction into the reminder union.
- **2026-09-26 — token usage is summed per turn, not per call.** Rejected: one chip per
  call; showing both; deriving the sum in web; counting a missing-usage call as 0 (declared
  as `missingUsageCalls`); using the session's current provider for historical turns
  (`source.providerId` is provenance only). Dollar cost was out of scope for that iteration.
- **2026-10-23 — compaction budget is anchored; calibration is observe-only.** Rejected:
  improving the absolute tokenizer first; trusting an anchor without the
  `usage >= heuristic total` guard; writing calibration into config or thresholds. Precise
  tokenizers and the per-model bytes-per-token factor were deferred; the latter is unwired.
- **Reversal note (task-r6).** The 2026-09-04 spec left `EventSink` unchanged and kept
  streaming and persistence independent; the code now streams every stamped event it
  persists, and the gateway's transcript/delta split depends on that stamp.

## How to change it (tests to run)

Adding or changing a transcript event:

1. Add it to `TranscriptEventMap` (`packages/core/src/ports.ts`); if the reducer originates
   it, add the emit branch in `packages/core/src/reducer.ts`.
2. Write it through `recorder.record(...)` in `forwardEmit` / `interpretEffects` /
   `runModelStream`, or SDK `bestEffortAppend` for pre-Runner failures. Never emit a raw
   twin with the same name.
3. Teach the projections: `buildTurnRecords` (`transcript-projection.ts`) for turn
   structure, `toTrajectoryView` / `toConversationView` (`view-projection.ts`) for a row or
   field, `foldSnapshotEvent` / `foldContextUsageEvent` (`context-usage.ts`) for surface
   accounting. Touch the gateway only if the event needs special framing.
4. For a new drawer field, update `apps/web/lib/trajectory-view-model.ts`, both locale
   catalogs (`messages/{en,zh}`, `trajectory` namespace) and `TabBody` in
   `TrajectoryDrawer.tsx`.

Cost changes: pricing is `packages/core/src/pricing.ts`, the budget gate is
`accumulateUsage` / `checkBudgetLimits`, per-call telemetry is in `runModelStream`'s
`finally`, and the UI fold is `summariseTurnUsage`; changing one alone makes the meter and
the transcript disagree. Before making the SDK `CostMeter` live, give it a model, forward all
four token buckets, call `reset()` per turn and `result()` at the turn boundary.

```bash
pnpm turbo run typecheck lint test --filter @voltojs/core --filter @voltojs/runtime-node \
  --filter @voltojs/sdk --filter @voltojs/gateway --filter @voltojs/web --filter @voltojs/eval
```

Most relevant: `packages/core/src/__tests__/{context-usage,pricing,view-projection-views,transcript-projection,replay}.test.ts`;
`packages/runtimes/node/src/__tests__/{transcript-recorder,transcript-events,runner-cost-budget,runner-token-budget-cache,runner-usage-unavailable,runner-anchor-budget,telemetry-tracing,otel-telemetry}.test.ts`;
`packages/sdk/src/__tests__/{cost-meter,stream-channel,debugger,sse-types}.test.ts`;
`apps/gateway/src/__tests__/{trajectory-e2e,session-tail,server}.test.ts` and the
`apps/web/__tests__/{turn-usage-model,session-stats-model,context-usage,trajectory-drawer}.test.ts`.

Changing `TranscriptEventMap`, `TokenUsage` or `EventSink` is a cross-package contract
change: run the repository gate excluding desktop (`--filter '!@voltojs/desktop-app'`) and
rebuild upstream `dist` packages before host tests.

## Further reading (archive links)

- [Archive index](../archive/INDEX.md) — locate specs and plans by date;
  [transcript event log v2 (2026-09-04)](../archive/superpowers/specs/2026-09-04-transcript-event-log-v2-design.md) — vocabulary, aggregate persistence, header dedupe.
- [View projection consolidation (2026-09-04)](../archive/superpowers/specs/2026-09-04-view-projection-consolidation-design.md) — one `TurnRecord` intermediate, core projections, `event`/`delta` frames.
- [Web trajectory view (2026-09-05)](../archive/superpowers/specs/2026-09-05-web-trajectory-view-design.md) — row list plus drawer, dual sourcing.
- [Context usage meter (2026-09-06)](../archive/superpowers/specs/2026-09-06-context-usage-meter-design.md) /
  [precision (2026-09-07)](../archive/superpowers/specs/2026-09-07-context-usage-precision-design.md) — anchor + delta, independent breakdown, snapshot boundary, usage normalization.
- [Context reminder audit (2026-09-11)](../archive/superpowers/specs/2026-09-11-context-reminder-audit-design.md) — auditable injections and the closed `kind` union.
- [Turn token usage (2026-09-26)](../archive/superpowers/specs/2026-09-26-turn-token-usage-design.md) — per-turn aggregate, cache-hit denominator, missing usage, provenance-only `providerId`.
- [Tokenizer calibration (2026-10-23)](../archive/superpowers/specs/2026-10-23-tokenizer-calibration-design.md) /
  [cache-hit analysis (2026-10-23)](../archive/superpowers/reports/2026-10-23-cache-hit-6td66cf8h.md) — anchored budget, observe-only calibration, and the empirical data behind it.
