---
title: Architecture
status: current
source:
  - packages/core/src
  - packages/sdk/src
  - packages/runtimes/node/src
verified: 2026-11-13
supersedes:
  - docs/archive/root/pure-agent-core.md
---

# Architecture

volto is a pure functional kernel with a deliberately thin imperative shell. All decisions
— what to ask the model, which tool may run, how context is ordered, whether to compact —
are made by pure functions in `packages/core`; everything that touches the outside world is
a port call made by a Runner outside the kernel. This page describes that split as the code
implements it today. `docs/archive/root/pure-agent-core.md` (local archive, not published) explains the original
intent; where the two disagree, this page follows the code.

## Scope and where it sits

The repository is a pnpm workspace with three layers plus hosts:

```text
apps/gateway · apps/web · apps/desktop-app        wiring, transport, UI
        │
packages/sdk                                      createAgent() facade, per-turn assembly
        │
packages/runtimes/node                            Runner: the only effect interpreter
        │
packages/core                                     step(), ports, pure decision modules
```

Dependencies point downward. Sideways, `packages/tools/*`, `packages/providers/*`,
`packages/stores/*`, `packages/embedders/*` and `packages/memories/*` supply adapters and
tool definitions that the SDK and the Node runtime assemble. The kernel does not know any
of them.

A conversation is a sequence of turns; inside one, the core moves through
`idle → calling_model → executing_tools → calling_model → … → done`, with
`waiting_for_approval`, `waiting_for_input` and `cancelling` as side states. Each
transition is one `step(state, input, ctx)` call.

This page covers the kernel shape, port surface, Effect/Runner contract, package direction
and the invariants; turn lifecycle, context, persistence, tools and sandbox are on sibling pages.

## The pure core (state machine, ports, Effect)

`packages/core` has no runtime dependencies (`packages/core/package.json`:
`"dependencies": {}`, `"peerDependencies": {}`, `"devDependencies": {}`). It imports only
its own relative modules. The public barrel is `packages/core/src/index.ts`.

### State

`AgentState` (`state.ts`) is the complete serializable state: `messages`, `pendingTools`,
`status`, resource limits (`tokenBudget`, `maxIterations`, `maxToolCalls`,
`maxCostDollars`, `maxTokensPerTurn`, `maxWallclockMs`, `maxLoopCount`,
`maxSelfCorrections`), counters (`tokensUsed`, `iterationCount`, `toolCallCount`,
`selfCorrectionCount`, `loopInterventionCount`, `loopRemindedCount`), the read-before-edit
record `readFiles`, the steering queue `queuedUserInputs`, and cross-turn context
(`todos`, `contextLayers`, `pinnedMessageIds`, `backgroundTasks`, `_announced*`
fingerprints). Every field is plain data; a checkpoint is a JSON write, not a callback.

Three shapes keep state small and replayable:

- `ImageContent.source` is `{ type: "ref", id, mediaType }`. Bytes live in an
  `AttachmentStore`; the Runner swaps refs for base64 on the request surface.
- `BackgroundTask` records metadata only. A promise handle cannot be serialized and stays
  with the Runner/registry, so a resumed Runner can discover a task and fail it rather
  than wait forever.
- `ToolResultContent.content` is always `ToolResultBlock[]`; `normalizeToolResultContent()`
  collapses a tool's plain string on the way in, so consumers handle one shape.

`ReducerState` (`reducer.ts`) extends `AgentState` with fields the reducer needs while
streaming and resolving a batch: `_accumulatedText`, `_accumulatedReasoning`,
`_accumulatedToolCalls`, `_toolResultBuffer`, `_announcedPermission`, and
`_announcedPermissionConfig`. They are plain data as well, and `resetTurnForNextInput()`
clears them at a turn boundary. `StepContext` is the non-serializable half — visible tools,
model parameters, context layers, permission config, `Id`/`Clock` ports, reminder
channels. Only `state` is checkpointed.

`createInitialState()` produces an `idle` state with no iteration cap by default.
`resetTurnForNextInput()` clears turn-scoped counters and buffers while preserving
`messages`, `readFiles`, `queuedUserInputs`, `contextLayers` and the pinned ids; the SDK
uses it to carry a conversation into the next turn's Runner.

### Inputs and Effects

`AgentInput` (`input.ts`) is a closed union of 20 inputs, grouped by who produces them:

| Producer | Inputs |
| --- | --- |
| Host / human | `user_message`, `steering_flush`, `steering_edit`, `steering_remove`, `cancel`, `file_changed` |
| Model adapter | `model_chunk`, `model_done`, `model_error` |
| Tool / approval | `tool_result`, `request_approval`, `approval_decision` |
| Runner guards | `budget_exceeded`, `self_correct`, `loop_reminder`, `loop_intervention` |
| Deterministic write-back | `tool_results_pruned`, `compaction_applied` |
| Sub-agents | `background_task_started`, `background_task_completed` |

`Effect` (`effect.ts`) is the kernel's only way to express intent: `call_model`,
`request_approval`, `emit`, `checkpoint`, `done`.

`step()` dispatches on `state.status` after a block of status-independent handlers
(`budget_exceeded`, `self_correct`, `steering_edit/remove`, loop reminders,
`tool_results_pruned`, `compaction_applied`, background tasks, `file_changed`). The
important cases are structural rather than exhaustive:

- A model response is fed back as `model_done`; a `tool_use` stop reason moves the state
  to `executing_tools` and records `pendingTools`, while `end_turn` emits
  `emit` + `done`.
- Parallel tool results are buffered by tool-call id and flushed in `pendingTools` order
  (`_toolResultBuffer`), so message order does not depend on completion order.
- `request_approval` moves the call out of `pendingTools` into `pendingApprovalTool`,
  emits a `checkpoint` effect *and* a `request_approval` effect. The allow branch restores
  the call to the roster; the deny branch buffers an `isError` tool result so a mixed
  batch can still flush.
- `compaction_applied` and `tool_results_pruned` rewrite `state.messages` in the reducer.
  The Runner never mutates state; it computes, then feeds an input.

### Pure decision modules

| Module | Entry points | What it decides |
| --- | --- | --- |
| `context-assembler.ts` | `assembleContext`, `buildToolPrompt` | Order messages into system → context layers → pinned → chronological; return `staticPrefixLength`, `cacheBreakpoints`, `layerOrigins`. Tool definitions travel in `ModelRequest.tools`, not in messages. |
| `compactor.ts` | `decideCompaction`, `buildSummaryPrompt`, `estimateTokens` | Whether to compact, which message ids to replace, which messages to keep. The summarization call itself is made by the Runner. |
| `compaction-budget.ts` | `deriveCompactionMaxTokens` | Window-aware trigger from context window, ratio and headroom. |
| `tool-router.ts` | `filterVisibleTools`, `filterByScope`, `validateToolInput`, `routeToolCall` | Capability gating, risk ceiling, scope/limit trimming, required/enum input checks. |
| `permission-policy.ts` | `resolvePermission`, `decide`, `narrowPermission` | Rule-first, then the sandbox × approval matrix; monotonic narrowing for sub-agents. |
| `file-gate.ts` | `evaluateEditGate`, `evaluateOverwriteGate` | Read-before-edit and staleness checks from `readFiles`. |
| `loop-detector.ts` | `detectLoop` | Identical repeated tool calls, repeat vs error chains. |
| `self-correct.ts` | `decideSelfCorrect` | Whether a validator failure earns a repair prompt. |
| `tool-result-prune.ts`, `tool-result-spill.ts`, `compaction-image-offload.ts` | `pruneOversizedToolResults`, `decideSpill`, `planImageOffload` | Deterministic reductions of oversized or image-heavy history. |
| `error-taxonomy.ts`, `guardrails.ts` | `classifyError`, `annotateUntrusted` | Retry classification and untrusted-content markers. |
| `transcript-projection.ts`, `view-projection.ts` | `projectMessages`, `buildTurnRecords`, `toConversationView` | Read-side projections from the event log. |

### Ports

`ports.ts` defines the interface contracts the shell implements. It is predominantly
types; the one value export is the `ReasoningEffortId` brand constructor. The surface is
larger than the original design's short port list and falls into five groups:

| Group | Ports |
| --- | --- |
| Model and tools | `ModelPort`, `ToolSource`, `SkillRegistry`, `PlanStore` |
| Environment | `FileSystem`, `Shell`, `Network`, `Sandbox`, `Secrets`, `AttachmentStore`, `SpillStore`, `FileWatcher`, `Scheduler` |
| Persistence | `SessionStore` (whole-state snapshots), `TranscriptStore` (append-only event log), `TranscriptReader`, `MemoryStore`, `Embedder`, `Cache` |
| Control and output | `EventSink`, `ApprovalGate`, `PolicyEngine`, `Telemetry` |
| Determinism | `Clock`, `Id`, `Random`, `Tokenizer` |

Two persistence ports exist because they answer different questions. `SessionStore` stores
a whole `AgentState` for checkpoint/resume; `TranscriptStore` appends events for display and
audit and is never read back into a running turn. `TranscriptReader` is separate so a
write-only audit sink is a legal implementation.

Port absence is meaningful: a tool whose `requires` capability has no provider is filtered
out of the visible set before the model sees it. Nothing in core assumes a port exists.

## The imperative shell (Runner, SDK, hosts)

### The Runner

`packages/runtimes/node/src/runner.ts` is the only implementation of the
functional-core/imperative-shell loop. `createRunner(opts: RunnerOptions)` closes over the
current `ReducerState`, the `StepContext`, port adapters, and turn-scoped bookkeeping
(cancellation flag, approved/denied tool-call ids, budget counters, step counter,
transcript recorder).

- `feed(input)` calls `step(state, input, stepContext)` and replaces `state`.
- `runLoop()` is status-driven. It checks budgets, dispatches `calling_model` to
  `runModelStream()`, partitions `executing_tools` into parallel/approval batches, drains
  background tasks at a would-be `done`, and breaks on terminal or waiting states.
- `runModelStream()` applies compaction, assembles the request with `assembleContext()`,
  injects RAG when configured, resolves image refs, calls `ModelPort.stream()`, and feeds
  every event back as `model_chunk` / `model_done` / `model_error`.
- `executeTool()` runs `routeToolCall()`, then `preToolUse` hooks, the `ToolExecutor`,
  `postToolUse` hooks, spill interception, and error normalization.
- `interpretEffects()` performs the two effects that must happen at feed time:
  `checkpoint` (written before any approval interaction) and `request_approval` (awaits the
  `ApprovalGate` and feeds `approval_decision`). `call_model`, `emit` and `done` are not
  interpreted; status transitions and `forwardEmit()` drive them, and `runModelStream()`
  re-assembles the request after compaction.
- `run()`, `resume()`, `send()`, `compactNow()`, `getState()`, `getLastTurnEnd()` are the
  public surface.

Tool visibility is fixed when the Runner is constructed:
`filterVisibleTools(stepContext.tools, availableCapabilities, riskCeiling)` is applied once,
and the SDK builds a fresh Runner per turn. Tool-set changes therefore land at turn
boundaries, which is what keeps the provider cache prefix stable.

Permission is enforced in the shell because two of its inputs are I/O: the Runner resolves
declared path inputs (absolute + symlinks) and URL hostnames via
`createToolInputFactResolver()`, collects declared command inputs, then calls the pure
`resolvePermission()`. An external `PolicyEngine` is consulted next, most-restrictive-wins,
fail-closed on a throw. `deny` becomes an `isError` tool result; `ask` goes through the
`ApprovalGate`.

Errors do not escape the loop. A tool throw becomes an `isError` `ToolResult`; a provider
`error` event or throw becomes `model_error`; a stream with no terminal event is treated as
truncated (text is preserved, a cut inside a tool call becomes `model_error`). The
`turn_end` event records `error` / `budget_exceeded` / `cancelled` / `done`, so a turn that
was cut off is distinguishable from a clean completion.

Persistence happens at three points: the reducer's `checkpoint` effect at a HITL pause,
the Runner's `sessionStore.save()` for the canonical id and `<id>#<seq>` history at every
completed turn, and the transcript recorder, which appends `TranscriptEvent`s and mirrors
them to the `EventSink` in the same stamped form.

### The SDK facade

`packages/sdk/src/create-agent.ts` exports `createAgent(opts: CreateAgentOptions):
AgentInstance`. `modelPort` is the only required port. The SDK resolves defaults from
`packages/sdk/src/defaults.ts` (`defaultClock`, `defaultId`, `defaultTokenizer`,
`defaultEventSink`, `createDefaultSessionStore`, `defaultChatStore`,
`createDefaultMemoryStore`, `defaultPolicyEngine`, …), assembles tools from custom tools,
adapter-backed tools, plugins and `ToolSource`s, trims the visible set with
`buildDefaultToolVisibility()` + `filterByScope()`, resolves the permission config
(`createDefaultPermissionConfig()` = `workspace-write` + `ask`), and builds one Runner per
turn.

`AgentInstance` is `run`, `stream`, `steer`, `updateQueue`, `resume`, `compactNow`,
`getState`, `dispose`, plus the `sessionStore` and `ports` snapshots. `run()` returns the
final state; `stream()` wraps the same Runner in a `StreamChannel` and yields
`{ type, data }` events; both share the single-turn-at-a-time contract. `resume()` tries
the in-memory Runner first and falls back to a checkpoint; the Runner's `resume()` requires
`status === "waiting_for_approval"` and a `pendingApprovalTool`.

Two defaults matter. The default `ApprovalGate` is `createAutoAllowGate()`, so an `ask`
decision is approved automatically unless the host injects a real interactive gate. The
default transcript store is a no-op (`defaultChatStore`), so nothing persists unless the
host passes a `TranscriptStore`.

Sub-agents are SDK assembly, not a kernel feature: `assembleSubAgent()` intersects the
definition's tools and capabilities with the parent's, completes a partial policy from the
parent, and runs the result through `narrowPermission()`. A child gets its own Runner and
its own transcript session; the parent receives the collected result as a tool result or a
background-task notice.

### Hosts

`apps/gateway` is the reference host: `src/wiring.ts` calls `createAgent()` with provider,
filesystem/shell/network adapters, sandbox decorators, stores and permission rules, and
`src/server.ts` exposes HTTP and SSE. `apps/web` is a Next.js client of that SSE protocol
and imports `@voltojs/sdk` for types, not for the kernel. `apps/desktop-app` is an Electron
host with the same SDK surface plus approval dialogs. Hosts only wire and subscribe; a host
that needs kernel behavior changes is a sign the boundary is wrong.

`packages/runtimes/browser` and `packages/runtimes/edge` currently ship port adapters only
(`FileSystem`, `Network`, and in browser also `Tokenizer`); the Runner is Node-only. The
kernel itself is portable because it never imports a runtime, but the shell is not yet
implemented twice.

## Dependency direction and package boundaries

The rule is one-way: `core ← tools-*/providers-*/runtimes-*/stores-*/embedders-*/
memories-* ← sdk ← apps/*`. The mechanical checks are:

- `packages/core/package.json` must keep `dependencies` and `peerDependencies` empty;
  `scripts/check-core-zero-deps.mjs` fails CI otherwise.
- `.eslintrc.cjs` applies `no-restricted-imports` to `packages/core/src/**`: `node:*` and
  an enumerated list of `@voltojs/*` implementation packages are banned, as are
  `Date.now()`, `Math.random()` and the `crypto` global. Test files under
  `packages/core/src/__tests__` are exempt.
- `@typescript-eslint/consistent-type-imports` is enabled for
  `packages/tools/*`, `packages/stores/*` and `packages/memories/*`: those packages consume
  core contract types only.

`zod` is allowed in `packages/tools/*` and `packages/sdk`; core knows only the abstract
`JSONSchema` in `tool.ts`, and `toJSONSchema` conversion happens where the tool is defined.
The Runner and the SDK are the exception to type-only imports: they are the executors and
value-import `step`, `createInitialState`, `filterVisibleTools`, `resolvePermission` and
the other pure functions. Importing pure functions does not couple the kernel to an
implementation.

Naming follows the package's role: category directories are plural (`tools/`,
`providers/`, `runtimes/`, `stores/`, `memories/`). Each category is one package with a
subpath per group — `@voltojs/tools/fs`, `@voltojs/providers/openai`,
`@voltojs/stores/jsonl` — except the runtime adapters and the native/driver-backed
stores, which stay separate (`runtime-node`, `store-sqlite`, `store-postgres`). The merged
`runtimes-web` package is private until the browser and edge runtimes are complete.

The workspace globs are `packages/*` (core, sdk, tools, providers, stores, memories,
eval) and `packages/*/*` (runtimes/node, runtimes/web, stores/sqlite, stores/postgres),
plus `apps/*`.

## Invariants (purity, determinism, replay)

1. **Purity.** No I/O, no ambient time, randomness or identity in `packages/core/src`.
   Time, ids and randomness enter through `StepContext.clock` / `StepContext.id` or a port
   passed as an argument; token counts go through `Tokenizer`. ESLint is the first gate;
   code review is the second.
2. **Zero dependencies.** The kernel is installable without any adapter. Adding an import
   of another workspace package to `packages/core` breaks the premise even if it would
   typecheck.
3. **Determinism.** The same `AgentInput` sequence, the same initial state and the same
   `StepContext` must produce byte-identical `(state, effects)`. Every non-deterministic
   fact (model chunks, tool results, approval decisions, prune/compaction write-backs)
   enters as an input, and ambient time/ids go through injected ports. Parallel tool
   completion order is erased by `_toolResultBuffer` + `pendingTools`-order flush.
4. **Replay is a test, not a slogan.** `packages/core/src/__tests__/replay.test.ts` runs a
   full user → tool_use → tool_result → text → done sequence twice and compares states and
   effects; `subagent-replay.test.ts` and `permission-mode-replay.test.ts` cover the
   narrower paths. A reducer change without a replay run is unverified.
5. **Serializable state.** Every checkpoint is JSON. Anything that cannot be serialized
   (promises, abort controllers, model handles) lives in the Runner or a registry, never in
   `AgentState`.
6. **Errors are inputs.** Tool failures, model failures, permission denials and hook
   denials become `isError` `ToolResult`s or `ModelError` inputs. Throwing out of the loop
   is reserved for a corrupted checkpoint or a misconfigured Runner.
7. **Capability gating and permission are separate.** `filterVisibleTools()` decides what
   the model can see (missing capability or above the risk ceiling = invisible).
   `resolvePermission()` decides whether a visible call is allowed. Collapsing the two
   would make a tool look absent when it was actually refused.
8. **Write-back, not mutation.** The Runner computes compaction, pruning, steering or
   background-task facts, then feeds an input; the reducer is the only writer of
   `state.messages`. This is what makes a compaction reproducible from the input log.

Known limits: provider output is external, the filesystem can change under a running turn,
wallclock budgets read `Date.now()` inside `checkBudgetLimits()` / `runLoop()` even when a
`Clock` is injected, and transcript timestamps are host wall-clock. The transcript is a
display/audit log, not the replay source; replay uses recorded inputs and checkpoints.

## Decisions and rejected alternatives (with dates)

| Date | Decision | Rejected alternative / reversal |
| --- | --- | --- |
| 2026-06-03 | Reducer + Effect array (`step(state, input) → { state, effects[] }`) as the only control flow; `Effect` is data the shell interprets. | An `async` main loop with injected ports would be more familiar but hides termination, retries and I/O, and cannot be snapshot-tested. |
| 2026-06-03 | Capability gating as the portability mechanism: tools declare `requires`, missing capabilities remove them from the visible set. | Per-host conditional tool lists duplicate the same environment branches in every host. |
| 2026-09-03 | Context layers are separate synthetic system messages, not one merged blob; `layerOrigins` carries provenance; RAG is inserted after assembly because its index depends on `cacheBreakpoints`. | Merging layers loses "which file did this come from" and makes one changed layer invalidate the whole prefix. |
| 2026-09-04 | One append-only event log is the durable record; `Message[]` is projected by a pure core function; chunks are aggregated into one `assistant_message`; the static header is written once per hash. | The earlier design kept both a `message` row and trajectory rows and relied on convention to keep them consistent; `SessionStore`-only would not answer "what was actually sent". |
| 2026-09-09 | Permission = sandbox (ceiling) × approval (interruption); the `plan` permission mode is deleted; above the ceiling an `ask` policy escalates instead of denying. | A single permission enum conflated boundary and interruption; `plan` had no planning semantics behind it. |
| 2026-09-10 | No session-scoped "always allow" grant; `dynamicRules` deleted. | A grant that survives turn, project and mode changes is not what the user consented to. The 2026-09-20 remember-rule feature later added persistent, visible `permissions.json` entries instead — no in-memory session grant. |
| 2026-09-20 | Parameter permission rules (`pathPattern`, `hostPattern`, `commandPrefix`) are matched by core against facts the Runner resolves; command rules use strict argv tokenization and disqualify any command containing shell metacharacters. | Core resolving symlinks or parsing commands would be I/O or unsound guessing; matching raw text invites bypass through quoting. |
| 2026-10-15 | Default visible tool set is governed: 20 tools (21 with memory, more with browser/LSP), with a 14-tool floor and a five-tier table; a host `toolVisibility` replaces the default. | Leaving the default at `Infinity` let a ~53-tool session degrade tool selection; merging host tables with the default makes the result unexplainable. |
| 2026-10-16 | Compaction write-back enters the reducer as `compaction_applied`; preserved images ride a dedicated user-role carrier after the summary. | The 2026-09-15 design had a `system` summary, and the 2026-10-16 v1.0 design put images inside it; system content is text-only on every provider wire. The 2026-10-23 cache report records the later move of the summary itself to a user-role message so it stays behind the static prefix. |
| 2026-10-23 | No default `maxIterations`; the turn is bounded by resources (tokens, cost, wallclock) and the loop ladder, with SDK default `maxLoopCount = 3`. | The original design capped iterations in core; a hard cap killed long tasks silently. |

## How to change it (what to run, what breaks)

Static gates, scoped to the affected packages:

```bash
pnpm turbo run typecheck lint test --filter @voltojs/core
pnpm turbo run typecheck lint test --filter @voltojs/runtime-node
pnpm turbo run typecheck lint test --filter @voltojs/sdk
```

`lint` for core runs `node scripts/check-core-zero-deps.mjs && eslint src/`, so purity and
zero dependencies share one gate. Do not run the whole repo by default; exclude
`@voltojs/desktop-app` when a cross-package run is genuinely needed
(`--filter '!@voltojs/desktop-app'`). Downstream packages consume `dist`, so build the
upstream package before testing a cross-package change. Change-specific consequences:

- **Reducer / state shape.** Run `replay.test.ts` and the reducer suites. Any new field on
  `AgentState` must survive a checkpoint round-trip, a `resetTurnForNextInput()` and
  `projectMessages()`. The transcript event vocabulary and its projection usually need the
  same change; if the event shape moves, update `TranscriptEventMap` and the web reader.
- **New port.** Add the interface to `ports.ts`, a default to `packages/sdk/src/defaults.ts`
  when a benign default exists, an adapter in the relevant `runtimes/*` or `stores/*`
  package, and a capability name if a tool depends on it. A default that silently permits
  work is a security decision, not a convenience.
- **New tool.** Define `ToolDefinition` with `requires`, `riskTier`, `inputSchema`, and the
  `pathInputs` / `hostInputs` / `commandInputs` declarations the permission layer needs.
  Verify it survives `filterVisibleTools()` and `buildDefaultToolVisibility()`; add it to
  the right scope group or it lands in `rest` and competes for the last slots.
- **Effect or step change.** The Runner must feed a corresponding input. An effect nothing
  consumes is dead weight; an input the reducer does not handle in the current status
  becomes an `errorResult`, not a crash.
- **Docs.** A user-visible surface change (config key, default, tool visibility, error
  wording, SDK export) requires the matching `docs/user/` update and `pnpm docs:check`
  after a build. A change to this page's claims should keep the `verified` date honest.

## Further reading

- `docs/archive/root/pure-agent-core.md` (local archive, not published) — the 2026-06-03 design document this page
  supersedes. Read it for intent; do not treat its module list, port set or iteration policy
  as current.
- `ContextAssembler content layers (2026-09-03)`
  — the layer/origins design.
- `Transcript event log v2 (2026-09-04)`
  — why the log is append-only and projected in core.
- `Permission redesign (2026-09-09)`
  — sandbox × approval.
- `Security roadmap decisions (2026-09-10)`
  — threat model, `dynamicRules` removal, no session-scoped grants; followed by the
  `path/host rules`,
  `command-prefix rules`
  and `remember-rule` changes (2026-09-20).
- `Toolset governance (2026-10-15)`
  — the 20-tool table and its floor.
- `Compaction image offload (2026-10-16)`
  and the `cache-hit report (2026-10-23)`
  — user-role summary and image carrier.
- `Core readiness roadmap` — the ledger that
  records the 2026-10-23 iteration-cap and loop-ladder decisions.
- [SAFETY.md](../../SAFETY.md) — the threat model and the boundary strengths this
  architecture does and does not provide.
- Sibling pages: [core-loop](core-loop.md), [context-and-compaction](context-and-compaction.md),
  [sessions-and-persistence](sessions-and-persistence.md), [tools-and-permissions](tools-and-permissions.md),
  [models-and-providers](models-and-providers.md), [runtime-and-sandbox](runtime-and-sandbox.md),
  [gateway-and-hosts](gateway-and-hosts.md), [sdk-and-extensibility](sdk-and-extensibility.md),
  [observability-and-cost](observability-and-cost.md), [security](security.md).
