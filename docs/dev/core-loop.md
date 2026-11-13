---
title: Core loop
status: current
source:
  - packages/core/src
verified: 2026-11-13
supersedes:
  - docs/archive/superpowers/specs/2026-09-25-workflow-mode-reminder-design.md
  - docs/archive/superpowers/specs/2026-10-16-loop-intervention-design.md
  - docs/archive/superpowers/specs/2026-10-17-timeout-policy-design.md
  - docs/archive/superpowers/specs/2026-10-17-hooks-host-surface-design.md
  - docs/archive/superpowers/specs/2026-11-04-web-steering-queued-messages-design.md
  - docs/archive/superpowers/specs/2026-11-10-workspace-context-injection-design.md
---

# Core loop

## Scope and where it sits

A turn is a pure state machine driven by `step(state, input, ctx)` and interpreted by an
imperative runner. The core contributes data and decisions; the runner performs I/O.

| Layer | Location | Role in the loop |
| --- | --- | --- |
| Pure kernel | `packages/core/src/reducer.ts` (`step`, `createInitialState`, `resetTurnForNextInput`) | Status transitions, message history, budget counters, loop-ladder decisions |
| Contracts | `packages/core/src/state.ts`, `input.ts`, `effect.ts` | `AgentState` / `ReducerState`, the `AgentInput` union, the `Effect` union |
| Loop functions | `packages/core/src/loop-detector.ts`, `self-correct.ts`, `hooks.ts` | Detection, repair-prompt decisions, hook pipeline |
| Interpreter | `packages/runtimes/node/src/runner.ts` (`createRunner`, `runLoop`, `runModelStream`) | Calls the model port, executes tools, feeds results back, persists checkpoints |
| Facade | `packages/sdk/src/create-agent.ts` (`run` / `stream` / `resume`) | Builds one Runner per turn, carries state forward, injects ports |

There is no `turn*.ts` or `timeout*.ts` module in `packages/core/src`. Turn scoping lives
in `state.ts` / `reducer.ts`; timeouts are a shared vocabulary (`packages/tools/common/src/timeout.ts`)
plus runner-level budgets, not a core subsystem.

## Current behavior (inputs, state transitions, effects, termination)

### Inputs

`AgentInput` (`input.ts`) is plain data: `user_message`, `steering_edit`, `steering_remove`,
`steering_flush`, `model_chunk`, `model_done`, `model_error`, `tool_result`,
`request_approval`, `approval_decision`, `cancel`, `budget_exceeded`, `self_correct`,
`loop_reminder`, `loop_intervention`, `tool_results_pruned`, `compaction_applied`,
`background_task_started`, `background_task_completed`, `file_changed`.

`step()` handles a set of **cross-status** inputs before dispatching on `state.status`:

- `budget_exceeded` — only while a turn is active; pairs the tool roster and closes the turn.
- `self_correct` — appends the repair prompt as a user message and bumps
  `selfCorrectionCount` when `consumesBudget` is true.
- `steering_edit` / `steering_remove` — mutate `queuedUserInputs` in any status; an id that
  is no longer queued returns `errorResult` ("delivery wins", so a delivered message can
  never be rewritten).
- `loop_reminder` / `loop_intervention` — append the prompt and emit `context_reminder`;
  only the intervention handler bumps `loopInterventionCount`.
- `tool_results_pruned`, `compaction_applied`, `background_task_started`,
  `background_task_completed` — durable write-backs of Runner decisions.
- `file_changed` — wakes an idle turn, queues the notice mid-turn, drops with an `error`
  emit in `cancelling` / `done`; it never throws.

### Statuses

`AgentStatus` in `state.ts`:

| Status | Entered by | Accepted loop inputs |
| --- | --- | --- |
| `idle` | `createInitialState`, `resetTurnForNextInput`, a host | `user_message`, `steering_flush` |
| `calling_model` | turn opening, tool-batch flush, approval flush, `end_turn` with a non-empty queue, `max_tokens` continuation, retriable `model_error` | `model_chunk`, `model_done`, `model_error`, `cancel`, `user_message` (queued) |
| `executing_tools` | `model_done` with `stopReason: "tool_use"`, an approved call | `tool_result`, `request_approval`, `cancel`, `user_message` (queued) |
| `waiting_for_approval` | `request_approval` input | `approval_decision`, `cancel`, `user_message` (queued) |
| `waiting_for_input` | No producer in-tree; a host may seed it | `cancel`, `user_message` (queued) |
| `cancelling` | `cancel` in any active status | `cancel` (closes as `done`), `user_message` (queued) |
| `done` | normal close, limit close, `budget_exceeded`, exhausted loop ladder | `user_message` (queued); everything else is `errorResult` |

`user_message` is never rejected. Every non-idle status routes it to `queueUserMessage`,
which stamps an id from the `Id` port, appends to `queuedUserInputs` and emits
`steering_queued`.

### One iteration

1. Opening (`handleIdle.user_message`): the reducer appends up to three tail reminders —
   permission boundary (`_announcedPermission`), workflow mode (`_announcedWorkflowMode`),
   workspace (`_announcedWorkspace`) — drains any older queue, appends the new message,
   sets `status: "calling_model"`, and returns `call_model` plus a `user_message` emit.
   `steering_flush` is the same transition without a new message.
2. Model call (`runner.runModelStream`): assembles context (`assembleContext`), records
   the request, resolves attachment refs, streams the model port, and converts
   `ModelEvent`s to `AgentInput`s (`modelEventToInputs`). Deltas accumulate in
   `_accumulatedText` / `_accumulatedReasoning` / `_accumulatedToolCalls`.
3. `model_done`: the reducer finalizes the assistant message (reasoning block first, then
   text, then `tool_use` blocks), increments `iterationCount`, adds usage to `tokensUsed`,
   and branches on `stopReason`:
   - `tool_use` → `pendingTools` + `status: "executing_tools"`, one `tool_use_complete`
     emit per call;
   - `max_tokens` → another `call_model` unless the runaway guard fires;
   - `end_turn` → drains the steering queue into another `call_model`, otherwise `done`.
4. Tool batch (`runLoop`, `status === "executing_tools"`): the runner partitions
   `state.pendingTools` by `resolvePermission` (plus an optional `PolicyEngine`, most
   restrictive wins) into allow / ask / deny. Deny feeds an `isError` `tool_result`; ask
   runs the HITL flow sequentially; allow runs concurrently under `Promise.allSettled`
   through `executeTool`, which runs `preToolUse` / `postToolUse` and spills oversized
   output.
5. Result flush (`handleExecutingTools.tool_result`): the runner annotates untrusted
   results, results are buffered by tool-call id, and once every call has reported they are
   flushed in `pendingTools` order, the steering queue is drained, and one `call_model` is
   issued. Completion order therefore never affects the message sequence.

### Effects

`Effect` is a five-member union (`effect.ts`): `call_model`, `request_approval`, `emit`,
`checkpoint`, `done`. Only the runner performs I/O. `buildCallModelEffect` is the single
construction site for model requests, so cache breakpoints, layer origins and the standing
todo layer are identical at every call site.

### Termination

| Outcome | Trigger | Transcript `turn_end.reason` |
| --- | --- | --- |
| `done` | `end_turn` with an empty queue; `cancel` while `cancelling` | `done` |
| Budget | Runner `checkBudgetLimits` feeds `budget_exceeded` (`maxWallclockMs`, `maxCostDollars`, `maxTokensPerTurn`) | `budget_exceeded` |
| Limit | `limitReached` on `maxIterations`, `tokenBudget` or `maxToolCalls`; the error names the cap | `error` |
| Loop hard-kill | Error chain ≥ K with the intervention budget exhausted | `error` |
| Model error | Non-retriable `model_error`, or retries exhausted | `error` |
| Cancel | `cancel` from `calling_model` / `executing_tools` / `waiting_for_approval`, then the `cancelling` hop | `cancelled` |
| HITL pause | `waiting_for_approval` — the turn stays open; `resume()` closes it later | *(none until resume)* |

Every roster-clearing path calls `synthesizeInterruptedResults`, pairing each unfulfilled
`tool_use` with an `isError` `tool_result` (tier `"cancel"` or `"limit"`), because providers
reject a request whose tail assistant message has unpaired `tool_use` blocks. The wording is
shared with `transcript-projection.ts` so a resumed session replays the same bytes.

The runner also closes turns the reducer never sees: a stream that ends without a terminal
event is a truncated response and closes as an error (`runModelStream`), and an exception
escaping a tool executor is normalized into an `isError` result, never rethrown into the loop.

### Turn boundaries and entry points

- Hosts call `agent.run(input)` / `agent.stream(input)` / `agent.resume(sessionId, decision)`
  (`packages/sdk/src/create-agent.ts`). The SDK creates a **fresh Runner per turn** and
  carries state forward, applying `resetTurnForNextInput(previousState)` at the `done`
  boundary.
- `resetTurnForNextInput` clears pending tools, approval, `iterationCount`, `tokensUsed`,
  `toolCallCount`, `selfCorrectionCount`, both loop counters, reducer accumulators and
  `backgroundTasks`. It **preserves** `messages`, `readFiles`, `queuedUserInputs`,
  `todos`, `pinnedMessageIds` and the budget fields.
- The Runner persists a checkpoint when the turn closes as `done`, and for every
  `checkpoint` effect (the HITL pause is the only reducer source).
- A turn whose status is `done` but which still has `running` background tasks is not
  closed immediately: `drainBackgroundTasks` feeds `background_task_completed`, which
  pushes the status back to `calling_model` when the registry has a result; with nothing to
  feed the turn stays `done`.

## Hooks and interventions (loop detection, timeouts, reminders)

### Hooks

`hooks.ts` defines ten lifecycles: `session:start`, `session:end`, `turn:start`, `turn:end`,
`preToolUse`, `postToolUse`, `userPromptSubmit`, `preCompact`, `subagentStop`,
`notification`. `runHookPipeline` is pure orchestration: registration order, serial,
first `deny` short-circuits, `modify` patches merge per field with last-write-wins, and a
later hook sees the patched context.

Runner wiring (`runner.ts`):

| Lifecycle | Site | Deny semantics |
| --- | --- | --- |
| `session:start` / `session:end` | `run()` entry / `finally` | ignored |
| `turn:start` | Every iteration that enters `calling_model` | ignored |
| `turn:end` | After `runLoop`, skipped while `waiting_for_approval` | ignored |
| `userPromptSubmit` | Before the initial `user_message` is fed | Turn never starts: `[prompt rejected by hook: <reason>]` is appended, status `done` |
| `preToolUse` | `executeTool`, after permission, before the executor | `isError` tool result with the "do not route around the refusal" text |
| `postToolUse` | After the executor, before spill | `isError` tool result |
| `preCompact` | `runCompactionWriteBack`, after the compaction decision | Skips this compaction, emits `preCompact_skipped`, the turn continues |
| `subagentStop` | `task` result carrying `displayMetadata.sessionId` | Observe-only |
| `notification` | `budget_warning`, `approval_requested` | Observe-only |

Observe-only points await the pipeline and **discard the outcome** on purpose: a hook may
watch a subagent completion or a budget warning but can never alter, deny or swallow it.
A failing observe-only handler surfaces as a `hook_error` event.

`session:start` / `session:end` and `turn:start` are named for the logical bracket, not the
actual frequency: the SDK builds one Runner per turn, and `turn:start` fires once per model
call (a tool loop therefore fires it repeatedly). `resume()` closes with `turn:end` only.

Hosts can also install **command hooks** from `<configDir>/hooks.json`
(`apps/gateway/src/config/hooks.ts`). Parsing is fail-closed on unknown keys or fields;
`exit 0` = continue, `exit 2` = deny with the first stderr line, any other non-zero exit,
spawn failure or the 10s per-hook timeout is a fail-closed deny. Stdout never enters model
context, and command hooks cannot `modify` (code hooks can).

### Loop detection and the three-tier ladder

`detectLoop(priorMessages, currentAssistantMsg, newToolCalls, k)` scans the trailing
`assistant(tool_use) → tool_result` pairs (at most `k`) and counts two independent chains
per new call: `"error-loop"` (all identical calls failed) and `"repeat"` (all identical
calls succeeded). Mixed sequences never merge, the error chain is checked first, the new
pending call counts as 1, and `k < 2` disables detection.

The reducer's `model_done` tool_use branch is the only decision site, gated by
`ctx.maxLoopCount >= 2`:

1. Probe with K; if nothing is detected and `K >= 3`, probe with K-1.
2. `"error-loop"` with count ≥ K and `loopInterventionCount >= (ctx.maxLoopInterventions ?? 2)`
   → hard termination: `done` + `error` with the byte-identical message
   `Loop detected: tool "<name>" has been called <n> times with identical input and returned errors`.
3. Otherwise the reminder tier books `loopRemindedCount = consecutiveCount` when
   `loopRemindedCount < consecutiveCount` and either the chain is `"repeat"` at ≥ K, or the
   chain is `"error-loop"` at exactly K-1 with `K >= 3`. Booking never changes control flow.

Nothing is injected by the reducer. The Runner snapshots `loopRemindedCount` before feeding
`model_done` and re-runs the same dual probe (`decideLoopInjection`); a post-feed increase
means "reminder booked", and an error chain at ≥ K with budget left means "intervention".
The resulting `loop_reminder` / `loop_intervention` input is held in `pendingLoopInjection`
— one per batch, reset at the start of every `runModelStream` — and fired only after the
batch's tool results have all been fed and the status is back to `calling_model`. A
cancelled or terminated turn drops it.

Counters are separate and serialized: `loopInterventionCount` is bumped only by the
`loop_intervention` input, `loopRemindedCount` only by the reducer's ladder branch; both
reset at the turn boundary. Texts come from `renderLoopReminder` (error / repeat variant)
and `renderLoopIntervention`; the closing "Two more identical failures will force-stop this
turn" is fixed wording and does not track the configured budget.

### Timeouts and budgets

There is no timeout module in core; the policy is three layers with one vocabulary.

| Layer | Mechanism | Result |
| --- | --- | --- |
| Turn | Runner `checkBudgetLimits` on `maxWallclockMs`, plus `maxCostDollars` / `maxTokensPerTurn` (also checked mid-stream on each `usage` event) | `budget_exceeded` input → `done`, roster paired, `budget_exceeded` + `done` emits |
| Tool | Per-call timeout owned by the tool; bash defaults to `DEFAULT_TIMEOUTS.tool` (120 000 ms), the shell adapter sends SIGTERM then SIGKILL after 2 s and sets `ShellEventExit.timedOut` only for its own timer | bash maps a timeout to `isError: true` plus `renderTimeoutSignature` (`[timeout] <subject> timed out after <N>ms`); the Runner never retries |
| Network | `DEFAULT_TIMEOUTS.network` (30 000 ms) with a byte-identical signature in `runtime-node/network.ts` | Tool result `isError: true` |

`maxCostDollars` has a documented conflation: when no pricing table matches the model,
the accumulated quantity is raw tokens compared against a dollar limit (see
`accumulateUsage` in `runner.ts`).

The Runner performs no mechanical tool retry. A result carrying
`displayMetadata.timedOut === true` queues one budgeted `[TOOL TIMEOUT]` self-correct prompt
when `maxSelfCorrections` allows, telling the model it may retry with a larger `timeout` or
`run_in_background`; the decision stays with the model. Model-call retries are separate:
thrown stream errors go through `opts.retryPolicy` (exponential backoff, circuit breaker);
a retriable `model_error` fed to the reducer re-issues the call and counts against
`maxIterations` when one is configured (the default is `undefined`).

### Reminders

`context_reminder` is the observability vocabulary for injected text (and for text the model
receives out-of-band). In the reducer: `permission_boundary`, `workflow_mode`, `workspace`
(tail user-role messages, only when their fingerprint changes), `self_correction`,
`loop_reminder`, `loop_intervention`, `background_task`, `todo_list`. The Runner adds
`retrieval` for RAG injection. Permission reminders are plain text; workflow and workspace
reminders are wrapped in `<system-reminder>` tags.

The standing todo list is not a reminder message: `assembleContext` re-injects it as a
system layer (`TODO_LIST_LAYER_ID`) on every request, so compaction of historical tool
results cannot drop the plan.

## Invariants and boundaries

- **The reducer never throws.** Every invalid input, unknown status and stale id returns
  `errorResult` — an `error` emit with the state untouched.
- **Effects are the only I/O intent.** Time, ids and clocks enter through `StepContext`
  (`ctx.id`, `ctx.clock`); core imports no implementation package.
- **Replay determinism.** The same input sequence with the same `StepContext` produces the
  same `(state, effects)` sequence; every history-dependent decision is a pure function of
  serializable state.
- **Tool-call pairing.** No termination path may leave an unpaired `tool_use`.
- **Delayed injection ordering.** Repair prompts (`self_correct`, `loop_reminder`,
  `loop_intervention`) are fed only after a batch's tool results, never between siblings.
- **One injection per batch.** `pendingLoopInjection` is a single slot, overwritten at each
  `model_done` and cleared at each model call.
- **The ladder's two probes must stay byte-identical** between reducer and Runner; the
  Runner reads only the before/after delta of `loopRemindedCount` rather than re-deriving
  the tier.
- **`user_message` is never lost.** Queue in every non-idle status, drain at five sites
  (`idle` opening, `steering_flush`, tool-batch flush, approval flush, `end_turn`
  continuation), preserve original ids.
- **Core knows no mode names.** `workflowReminder.key`, workspace keys and permission
  configs are opaque data; the host owns their vocabulary and wording.
- **Observe-only hooks are not a mistake.** Their outcome is intentionally unused.

## Decisions and rejected alternatives (with dates)

| Date | Decision | Rejected alternative |
| --- | --- | --- |
| 2026-09-25 | Mode changes are announced as a tail user-role `<system-reminder>`, gated by an opaque fingerprint stored in `AgentState` (`workflowReminder`) | A static context layer (invalidates the cached prefix on every switch); host-synthesized input or host mutation of history; pinning or compactor-protecting the note |
| 2026-10-16 | Loop handling is a three-tier ladder with an independent `loop_intervention` input and its own budget (default 2); repeat chains are reminded, never intervened or terminated | Reusing `self_correct`; a single intervention tier; injecting a message immediately before terminating; giving repeat chains an intervention |
| 2026-10-17 | Hooks are installed through `hooks.json` command hooks with `0` / `2` / fail-closed exit semantics and a 10s timeout; `subagentStop` and `notification` are observe-only | JavaScript embedded in JSON; an SDK-only surface; environment-variable configuration; `modify` for command hooks; consuming the outcome at observe-only points |
| 2026-10-17 | Timeouts are a shared vocabulary (defaults table + `timedOut` identity + one signature), not one mechanism; the turn layer keeps `budget_exceeded` | A single `TimeoutManager`; rewriting SIGTERM / AbortController / wallclock into one mechanism; changing the turn layer |
| 2026-11-04 | `user_message` is queued in every non-idle status and drained at turn boundaries; delivery wins over edit/remove; the queue survives the turn boundary; interrupted `tool_use` blocks are paired | Dropping with a BUSY error; `errorResult` in `done` / `cancelling`; one turn per queued message; leaving unpaired `tool_use` on cancel |
| 2026-11-10 | The workspace fingerprint is deliberately not re-seeded across a rebuild — the next turn re-announces once | `initialAnnouncedWorkspace` plumbing; making the fingerprint survive rebuilds |

Reversals worth knowing: the 2026-10-16 spec's table gave both chains a K-1 reminder, but
the code books `"repeat"` reminders only at K and above (error chains at exactly K-1). The
2026-10-17 timeout default for tools was raised from 30s to 120s on 2026-11-06, and timeout
repair became a model-decided `[TOOL TIMEOUT]` prompt instead of any Runner retry.

## How to change it (tests to run, regression points)

Static gates for the affected packages, excluding the desktop app:

```bash
pnpm turbo run typecheck lint test --filter @voltojs/core
pnpm turbo run typecheck lint test --filter @voltojs/runtime-node
pnpm turbo run typecheck lint test --filter @voltojs/sdk
```

Changing a core public type, `AgentInput`, `Effect` or `StepContext` is a cross-package
contract change: build the upstream packages before testing downstream, since
`runtimes-*` and `sdk` consume `dist`.

Core tests that pin the loop:

- `__tests__/replay.test.ts` — identical `(state, effects)` across runs;
  `__tests__/subagent-replay.test.ts`, `permission-mode-replay.test.ts` — replay with
  seeded state.
- `__tests__/loop-detector.test.ts` — chain classification, verbatim texts, reducer ladder
  (a)–(h), replay with the ladder on.
- `__tests__/termination-pairing.test.ts` — every roster-clearing path pairs its `tool_use`.
- `__tests__/hooks-lifecycle.test.ts` — the lifecycle union and pipeline behavior.
- `__tests__/steering*.test.ts`, `reducer-approval.test.ts`, `reducer-parallel.test.ts`,
  `background-tasks.test.ts`, `workflow-injection.test.ts`, `workspace-reminder.test.ts`.

Runner/SDK tests that pin interpretation: `runner-loop-intervention.test.ts` (ordering,
full ladder, dedup, replay, budget isolation), `runner-hooks-lifecycle.test.ts` (the four
new points, observe-only denial, `hook_error`), `runner-time-travel.test.ts`,
`runner-hitl.test.ts`, `runner-terminal-errors.test.ts`, `runner-retry.test.ts`,
`background-drain.test.ts`, `runner-long-turn.test.ts`, plus
`packages/sdk/src/__tests__/loop-default.test.ts` (SDK default K = 3) and
`resume.test.ts`, `steering.test.ts`, `hooks.test.ts`.

Regression points to check explicitly when editing the loop:

1. Effect order at the turn opening: `steering_delivered`, `call_model`, reminder emits,
   `user_message`.
2. Result flush order follows `pendingTools`, independent of completion order.
3. Loop texts stay byte-exact; the hard-kill `error` text stays byte-identical to the
   pre-ladder path.
4. `loopRemindedCount` stays monotonic and `loopInterventionCount` is untouched by reminders.
5. Reminder injection always lands after every tool result of its batch.
6. `resetTurnForNextInput` keeps the steering queue and clears `backgroundTasks`.
7. A HITL pause does not write `turn_end`; the resume that completes the turn writes it once.

## Further reading (archive links)

- [Architecture](architecture.md) — purity invariant, ports, module boundaries.
- `Loop intervention design (2026-10-16)`
- `Timeout policy design (2026-10-17)`
- `Hooks host surface design (2026-10-17)`
- `Workflow-mode reminder design (2026-09-25)`
- `Web steering queue design (2026-11-04)`
- `Workspace context injection design (2026-11-10)`
- `Archive index`