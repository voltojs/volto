---
title: SDK and extensibility
status: current
source:
  - packages/sdk/src
  - packages/tools/agent/src
  - packages/tools/plan/src
  - packages/eval/src
  - apps/gateway/src/wiring.ts
verified: 2026-11-13
supersedes:
  - docs/archive/superpowers/specs/2026-09-16-subagent-wiring-design.md
  - docs/archive/superpowers/specs/2026-10-15-subagent-consolidation-design.md
  - docs/archive/superpowers/specs/2026-11-09-subagent-trajectory-communication-design.md
  - docs/archive/superpowers/specs/2026-11-11-subagent-permission-dispatch-design.md
  - docs/archive/superpowers/specs/2026-11-11-acceptance-verification-design.md
  - docs/archive/superpowers/specs/2026-11-12-standalone-sdk-gateway-web-design.md
---

# SDK and extensibility

## Scope and where it sits

`@voltojs/sdk` is the facade hosts program against. It turns ports and adapters into one
`createAgent()` call, assembles the per-turn `Runner`, and owns the extension surfaces
(tools, plugins, hooks, commands, skills, agent definitions, subagents). It owns assembly and
I/O wiring, never decisions: the reducer, tool router, permission policy, compaction and
acceptance decisions live in `@voltojs/core`.

```text
apps/gateway · apps/desktop-app        host wiring (ports, config, transport)
        │
packages/sdk                           createAgent(), per-turn Runner assembly, dispatch
        │
packages/runtimes/node                 Runner: the only effect interpreter
        │
packages/core                          step(), ports, pure decision modules
```

`packages/sdk/src/` today: `index.ts` (public barrel), `create-agent.ts` (facade, tool
assembly, subagent executor), `defaults.ts` (port defaults), `config.ts` (`mergeConfig`),
`plugin.ts` (protocol/registry), `agent-spec.ts` (`AgentSpec`, `resolveAgentSpec`,
`loadAgentSpec`), `agent-registry/` (scan, frontmatter, store, builtin, serialize),
`tool-scope-default.ts`, `commands.ts`, `skills.ts`, `hooks.ts` (core re-exports),
`model-router.ts` (unwired fallback wrapper), `cost-meter.ts`, `acceptance-verifier.ts`,
`stream-channel.ts`, `transcript-reader.ts`, `debugger.ts`, `sse/` (types, mapper, server,
client) and `file-refs/` (shared parser/annotator). Public entries are `.`, `./sse`,
`./file-refs` and `./package.json`; ESM-only, Node >= 22.

| Layer | Owns | Never does |
| --- | --- | --- |
| `packages/sdk` | Option resolution, tool/hook/plugin assembly, per-turn `Runner`, dispatch and acceptance, transcript reads, SSE protocol | Decide permissions, route tools, mutate core state |
| `packages/tools/agent`, `packages/tools/plan` | The `task`/`task_output` contract (schema, description, envelope, error normalization); `todo_write` | Dispatch, build a child runner, collect usage, persist |
| `packages/runtimes/node` | Runner, executors, gates, background drain, spill | Choose what the model may do |
| `packages/core` | `step()`, router, permission matrix, compaction, acceptance decisions, transcript types | Any I/O |

`@voltojs/eval` is **not** an SDK consumer: its `package.json` depends on `@voltojs/core`
only. It records and replays `step(state, input, ctx)` trajectories (`replayTrajectory`,
`createTrajectoryRecorder`) with seeded Clock/Id/Random and scripted `ModelPort`s
(`simulate.ts`); it never constructs a `Runner` or an `AgentInstance`.

## Current behavior (createAgent options, run/stream/resume, errors)

### createAgent and AgentInstance

`createAgent(opts: CreateAgentOptions): AgentInstance` is synchronous; all ports are resolved
at construction. `modelPort` is the only required option — `defaults.ts` supplies an in-memory
`SessionStore`, a no-op `EventSink`, a counter+wallclock `Id`, a `Date.now` clock, and
throw-if-called `Embedder`/`Sandbox`.

`CreateAgentOptions` groups as follows (`packages/sdk/src/create-agent.ts`); omitted defaults
are noted only where they change behavior.

| Group | Options | Notes |
| --- | --- | --- |
| Model | `model`, `providerId`, `maxTokens`, `temperature`, `reasoningEffort`, `responseFormat`, `modelVision`, `contextWindow`, `compaction`, `pricing`, `reasoningStrategy` | `compaction.maxTokens` derives from the window; 60k only when unknown |
| Tools/adapters | `fs`, `shell`, `sandboxConfig`, `cwd`, `sessionSpawner`, `network`, `egressPolicy`, `lsp`, `browserAdapter`, `db`, `documentParser`, `attachmentStore`, `scheduler`, `fileWatcher` (+`fileWatchAutoWake`, `onFileWatchEvents`), `planStore`, `tools`, `toolSources`, `toolSource` (deprecated), `capabilities`, `toolVisibility` | An adapter both creates its tools and grants its capability; `ask_user`, `todo_write`, `read_document` are always registered |
| Policy/limits | `permissionConfig`, `approvalGate`, `askUserGate`, `maxIterations`, `tokenBudget`, `maxToolCalls`, `maxTokensPerTurn`, `maxDollarsPerTurn`, `maxCostTokens` (deprecated), `maxWallclockMs`, `maxLoopCount`, `maxLoopInterventions`, `selfCorrectionMax`, `auditSink`, `policyEngine` | Default policy is `{ sandbox: "workspace-write", approval: "ask" }`; `approvalGate` defaults to auto-allow |
| Persistence/events | `sessionStore`, `chatStore` + `chatSessionId` + `chatMeta`, `eventSink`, `clock`, `id`, `initialMessages`, `pinnedMessageIds`, `initialTurn`, `initialStep`, `initialContextLayers`, `initialQueuedInputs`, `initialAnnouncedWorkflowMode`, `memoryStore`/`memory`/`embedder`, `telemetry`, `cache`, `secrets`, `sandbox` | `chatStore` is write-only; seeds are the only way to restore history into a rebuilt instance; `pinnedMessageIds` seeds the first turn and the state carries the set afterwards |
| Extensions and context | `systemPrompt`, `resolveContextLayers`, `resolveWorkspaceReminder`, `workflowReminder`, `skillRegistry`, `skillCatalogDescriptionMaxLength`, `plugins`, `hooks`, `commands`, `config` | Context layers resolve once per conversation; see "Plugins and extension points" |
| Subagents | `enableTaskTool`, `agentSpecs`, `maxAgentDepth`, `maxAcceptanceReworks`, `routingTiers`, `resolveSubagentModelPort` | Task tools exist only with `enableTaskTool`; depth default 2; rework budget clamped 0–2 |

`config?: ResolvedConfig` fills defaults **only for options resolved through the internal
`resolve()` helper**: `systemPrompt`, `model`, `maxTokens`, `temperature`, `reasoningEffort`,
`maxIterations`, `tokenBudget`, `maxToolCalls`, `maxCostTokens`, `maxTokensPerTurn`,
`maxDollarsPerTurn`, `maxWallclockMs`, `maxLoopCount`, `maxLoopInterventions`,
`permissionConfig`, `compaction`, `toolVisibility`, `enableTaskTool`, `reasoningStrategy`,
`responseFormat`, plus `capabilities`. `ConfigLayer.toolSources` and `ConfigLayer.pluginNames`
are merged by `mergeConfig` but never read by `createAgent`.

`AgentInstance`:

| Member | Contract |
| --- | --- |
| `run(input)` / `stream(input, { signal })` | Run one turn; `stream` yields `{ type, data }` and abort/break closes the turn as `cancelled` |
| `steer(input)` / `updateQueue(edit\|remove)` | Queue a user message (never opens a turn); edit/remove an undelivered one, returning `"live" \| "seed" \| "missing"` |
| `resume(sessionId, "allow"\|"deny")` | Continue a `waiting_for_approval` session, in memory then from `sessionStore` |
| `compactNow()` / `getState()` | Manual prune+summarize (`null` when nothing to do, `CompactionBusyError` mid-turn); latest state, or a throw on a cold instance |
| `sessionStore`, `tools`, `ports`, `dispose()` | Checkpoint store, construction-time tool snapshot, resolved ports, idempotent teardown |

One instance serves one turn at a time; overlapping `run()`/`stream()` calls are out of
contract (see "Invariants and boundaries").

### Turn assembly

`run()`/`stream()` call `resolveInput()` (slash command → skill gesture → raw text) and then
`createNextRunner()`:

1. The turn is claimed immediately: `turnCounter++` happens before any await, so a failure is
   attributed to the turn that was starting; `resolveContextLayersOnce()` then resolves the host
   layers plus `skill-catalog` once and stamps them on `ReducerState.contextLayers` for reuse.
2. Hooks merge in order (`opts.hooks`, then plugin hooks). A previous `done` state continues
   through `resetTurnForNextInput(previousState)`; a fresh conversation starts from
   `createInitialState()` seeded with messages, queued inputs, limits and the announced workflow
   mode.
3. `RunnerOptions` carries the per-turn `sessionId` (`session-${id.next()}`, for HITL
   checkpointing), `chatStore`/`chatSessionId`, `turn`, `backgroundRegistry`, `spill`,
   `pathRoot`, `promptAnchor`, RAG wiring and the injected `clock`.

`run()` returns `lastFinalState`, re-absorbing deliveries that landed in the Runner's settle
window. `stream()` bridges the Runner's synchronous `EventSink.emit()` to an async generator
through `createStreamChannel()`; a consumer break or external `AbortSignal` aborts the Runner,
which still closes with `turn_end` (`cancelled`), and a Runner rejection is rethrown after the
promise settles.

`resume()` tries the in-memory `lastRunner.resume()` and falls through to the store on any
failure. The store path requires `status === "waiting_for_approval"` and a
`pendingApprovalTool`, then rebuilds a Runner with the checkpointed state, resolved context
layers, the current turn number and `initialStep` when the host supplied the paused turn's
highest persisted step. It throws `Session not found: <id>`,
`Cannot resume session <id>: expected "waiting_for_approval" but got "<status>"`, or
`Cannot resume session <id>: missing pendingApprovalTool`.

### Errors

| Failure | Surface |
| --- | --- |
| Model/provider or tool failure | A model error is normalized into a reducer `model_error` input (the reducer decides retry versus ending the turn with `turn_end.reason === "error"`); a tool failure is a `ToolResult` with `isError: true` fed back to the model, so the loop continues |
| `resolveContextLayers` rejects (no Runner) or an existing Runner's `run()` rejects (e.g. a hook throws) | The first rejects `run()`/`stream()` and records a `turn_end` error when a `chatStore` is configured; the second propagates while the Runner records `turn_end` and the SDK appends a separate `error` event |
| Invalid resume target, `getState()` before any turn | Throws (messages above) |
| `compactNow()` mid-turn / `dispose()` failure | `CompactionBusyError` (code `"busy"`) / `AggregateError` naming how many of the four reclamations failed |

Transcript writes are best-effort (`bestEffortAppend`): a store that throws, including a
synchronous throw from a non-`async` `appendEvents`, can never turn a working turn into a
failed one.

### Steering

`steer()` resolves `steerTarget` synchronously: with a target it calls `Runner.send()`,
without one it buffers in `pendingSteerInputs` until the Runner materializes. `updateQueue()`
checks membership (live Runner queue, then `lastFinalState.queuedUserInputs`, then
`initialQueuedInputs` before any state exists) and returns where the id was found.
`mergeQueuedEdit()` rebuilds `[newText, ...originalNonTextBlocks]`, so attachments survive an
edit; a sent id reports `"missing"`.

## Plugins and extension points

### Plugin protocol

`plugin.ts` defines a plugin as named trusted local code with one `register(registry)` call.
`PluginRegistry` accepts `addTool`, `addProvider`, `addHook`, `addCommand`, `addSkill`,
`addAgentSpec`; `collectPlugins()` calls every `register` once and returns
`CollectedPlugins` (tools dedupe by name, the rest append in order), and
`createPluginToolSource()` exposes collected tools as a `ToolSource`.

`createAgent` consumes only `tools` (appended after `opts.tools`, executor map
last-write-wins), `hooks` (appended after `opts.hooks` in `createNextRunner()`) and
`agentSpecs` (merged below file definitions by `withPluginAgentSpecs()`/`scanAgentSources()`).
`providers`, `commands` and `skills` are collected and exposed but **not wired**; hosts use
`opts.commands` and a `SkillRegistry` instead.

Plugins are trusted local code, not a sandboxed format: a plugin tool still passes
`ToolRouter` capability gating, the risk ceiling and the permission policy like any other
tool. There is no plugin discovery/install surface in the SDK.

### Other extension points

- **Custom tools and dynamic sources** — `opts.tools: Tool[]` (`{ definition, handler }` from
  `@voltojs/tools-common`); `requires` must be granted or the tool is gated out, and `riskTier`
  must be at or below the policy ceiling. `opts.toolSources: ToolSource[]` are listed on the
  first turn and refreshed on `onChange`; a source tool with `callTool` is executable, others
  answer a normalized error. `agent.tools` is a construction-time snapshot and does not reflect
  later merges.
- **Hooks** — `opts.hooks` plus plugin hooks. Lifecycles (`packages/core/src/hooks.ts`):
  `session:start`/`end`, `turn:start`/`end`, `preToolUse`, `postToolUse`,
  `userPromptSubmit`, `preCompact`, `subagentStop`, `notification`. Serial in registration
  order; first `deny` short-circuits; `modify` patches merge last-write-wins; the gateway
  appends config-file command hooks after code hooks.
- **Commands and skills** — `opts.commands: SlashCommand[]` with `{{arg}}` templates resolve
  before skill gestures: `resolveInput()` checks a registered command first, then a skill
  gesture, then falls back to `renderCommand()`'s `Unknown command: /<name>. Available
  commands: …` prompt (`parseArgs` supports `key=value`, quoted values and positional args).
  `opts.skillRegistry` adds the `skill` tool and the `skill-catalog` layer (names and
  collapsed descriptions only, sorted by code point, capped at
  `skillCatalogDescriptionMaxLength`, minimum 16); a recognized `/name` gesture keeps the
  user's text verbatim and the body loads on demand. `expandSkillInvocation()` is exported
  from its module for tests but not from `index.ts`.
- **Agent definitions** — `opts.agentSpecs: AgentEntry[]`, normally from
  `scanAgentSources({ cwd, configDir, pluginSpecs?, knownToolNames? })`. Ascending priority:
  plugin, user `<configDir>/agents`, project `<cwd>/.volto/agents`; a later same-name
  definition wins and the loser stays visible with `shadowed: true`, while built-ins
  (`general-purpose`, `explore`) are the floor below every file source. Files use a
  dependency-free YAML subset (`frontmatter.ts`); unknown keys are preserved for round-trip and
  a malformed file becomes a warning. `createAgentStore()` is the create/update/delete layer
  over the same two directories.
- **Declarative agents and layered config** — `resolveAgentSpec(spec, registry)` is a pure
  `AgentSpec` → tools/capabilities/policy resolver; `loadAgentSpec()` instantiates it through
  `createAgent()`, independently of `agentSpecs` dispatch. An unknown `tools` name is reported
  as an error and the name is dropped rather than throwing; `loadAgentSpec` returns the agent
  with `specErrors: string[]` so the host can surface it. `mergeConfig(global?, project?,
  runtime?, strategy?)` deep-merges in priority order, concatenating arrays by default
  (`replace` per field) and reporting the winning layer per key.
- **Transcript reads and checkpoints** — `readConversation`/`readTrajectory` are thin reads
  over core projections; `createTimeTravelDebugger` lists and rewinds `<sessionId>#<seq>`
  checkpoints. The SSE contract itself is `@voltojs/sdk/sse` (see `docs/dev/gateway-and-hosts.md`).

## Subagents and orchestration

### Wiring

`enableTaskTool: true` (or config-layer `enableTaskTool`) grants `agent:task` and registers
`createTaskTool()` plus `createTaskOutputTool()`; `maxAgentDepth` (default 2) grants
`agent:can-delegate` to the main agent while the cap is above zero, and to a child only while
`depth < maxAgentDepth`. Both tools declare `requires: [agent:task, agent:can-delegate]`, so
capability gating — not a post-call refusal — removes them at the cap. The gateway enables the
task tool and passes the scanned `agentSpecs` (`apps/gateway/src/wiring.ts`); `apps/desktop-app`
wires the SDK without subagents. The `task` schema (`packages/tools/agent/src/task.ts`) is:

| Input | Meaning |
| --- | --- |
| `message` | Self-contained task; the child cannot see the parent conversation |
| `subagent_type` | Enum of offered types when a list exists, free string otherwise |
| `acceptance` | Criteria (max 2,000 chars) the dispatch is verified against |
| `run_in_background` | Return a task id immediately; collect with `task_output` |
| `model` | Per-dispatch tier id (enum in tier mode) |
| `permission` | `read-only \| ask \| auto \| full`; narrowing only |
| `title`, `system_prompt`, `tools` | UI label (never sent to the child), appended instructions, per-dispatch allowlist |
| `max_iterations`, `temperature`, `max_tokens`, `response_format` | Per-dispatch overrides |

The description renders the available types with assembled tool facts (`no tools`,
`tools: …`, `unavailable: …`) and the assignable tier menu. Unknown `subagent_type` values are
rejected by the enum before dispatch and again by an executor backstop
(`Unknown subagent_type "<x>". Available: …`); the tool normalizes any throw to
`Sub-agent error: <message>` with `isError: true`.

### Dispatch

`createSubAgentExecutor()` returns the per-dispatch executor. In order:

1. Resolve the parent policy and reject a widening `permission` **before any child Runner or
   provider I/O exists**, listing the presets the session may use (`plan` is never offered),
   then mint one `taskId` (`id.next()`) so the start/finish brackets, the tool result and any
   nested dispatch share a join key.
2. Strip the parent's `task`/`task_output` instances from the inherited set; a child below the
   cap gets a freshly bound `task` whose executor is one level deeper. `task_output` is never
   re-created (the background registry is per agent instance).
3. Assemble the child:
   - Tools/capabilities are intersections with the parent; omitted means the parent's set,
     empty means none. A typed definition omitting `tools` inherits the parent except the
     browser/computer-use set (`BROWSER_TOOL_NAMES`) — a silent exception to the
     "omitted = full set" rule.
   - Policy is completed from the parent on missing axes and passed through core
     `narrowPermission`; wider axes are reported in `downgrades` and
     `subagent_permission_downgraded`. Declared-but-dropped tools/capabilities emit
     `subagent_tools_dropped`, durably and on the live sink.
   - Permission chain: parent → dispatch preset (`narrowToParent`) → definition
     (`narrowPermission`), so neither layer widens; the child's own policy derives its
     `riskCeiling`, so a read-only child loses write tools from the visible set. Model chain:
     dispatch `model` → definition `model` → parent, with tier ids in tier mode — a
     per-dispatch unknown/unassigned tier throws, a definition reference degrades with
     `subagent_model_tier_unresolved`, and reasoning effort chains definition → tier → parent.
4. Emit provenance: `subagent_started` (child session id, label, depth, task id, `background`,
   `subagentType`, `title`, effective `permission`), then downgrade/drop events;
   `subagent_finished` closes the bracket once with `isError`, `durationMs` and an optional
   verification summary. All are written to the parent transcript and emitted on the parent
   sink with the dispatch turn.
5. Run the child on a fresh Runner: its own `createInitialState()` with a seeded system
   prompt, a fresh in-memory `SessionStore`, `createSubAgentApprovalGate()` (ask → deny), the
   parent's RAG wiring and spill root, and a child `sessionId`
   (`<parentChatSessionId>-sub-<id>` when a parent session exists). Child events are tagged
   with `agentDepth`, `agentLabel` and `childSessionId`; a per-dispatch tap accumulates
   `assistant_message.usage` into the envelope. Return
   `{ text, sessionId?, usage?, verification?, rejected? }` for sync dispatches.
6. For background dispatch, register the promise in `createBackgroundRegistry()` and return
   the `taskId` immediately; the registry normalizes rejections, caches settled results and
   exposes `pending()`/`isCollected()`, and the Runner drains uncollected tasks at the turn
   boundary (`drainBackgroundTasks`, `packages/runtimes/node/src/runner.ts`).

`task` renders a successful result as two text blocks: the child's text (or
`(Sub-agent completed with no output)`), then a bare JSON envelope
`{ childSessionId?, status: "completed", usage?, verification? }`. An exhausted acceptance
appends the failure list and sets `isError: true`. `task_output` uses the same envelope, sets
`relatedSessionId` in `displayMetadata`, and answers unknown ids as plain-text errors.

Nested delegation: a first-level child below the cap gets its own `task`, whose executor
targets `depth + 1` and narrows against **that child's** effective policy, not the root's; a
nested `run_in_background` is refused exactly rather than silently running synchronously,
because a child has no turn boundary to drain on. Parallel fan-out is not an SDK feature:
several `task` calls in one batch run as ordinary tool calls in the Runner's parallel batch,
with no scheduler, queue or concurrency limit beyond that.

### Orchestration

There is no orchestration module. The former `packages/sdk/src/orchestration.ts`
(`createOrchestrator`, topology nodes, `buildNodeRunner`) and the core topology types were
deleted with the acceptance work; `transcript-orchestration.test.ts` only tests
`createAgent`'s transcript recording. `task` dispatch is the only orchestration surface: the
model decides when and whom to dispatch, with no coordinator role, session-level agent binding
or parent→child message bus (a host or user can continue the child session through the normal
message path, recorded as `host-continuation`). Background results are collected by the model
(`task_output`) or by the Runner's turn-boundary drain; there is no cross-turn auto-wake, so a
detached task finishing after its dispatch turn cannot wake a new one.

### Acceptance verification

`acceptance` is optional; blank is no criteria. When present, the child sees the criteria in
its first message (`renderAcceptanceNotice`) and again, with failures and retry hint, in every
rework message (`renderReworkMessage`).

- `acceptance-verifier.ts` makes one tools-free call on the child's model port and model,
  `temperature: 0`, `maxTokens: 800`, `responseFormat: { type: "json" }`, with a 60 s
  `ACCEPTANCE_VERIFY_TIMEOUT_MS`. It extracts the first complete JSON object leniently;
  timeout, port error and unparseable output all become `status: "error"`, never `failed`.
- `decideAcceptance()` reworks while `attempts <= maxReworks`; the budget is
  `maxAcceptanceReworks` clamped to 0–2 (default 1). A rework is a **new Runner** seeded with
  `resetTurnForNextInput(lastState)` and the next child turn number — never a second `run()`
  on a settled Runner — reusing the same `taskId` and usage tap. `composeAcceptanceOutcome()`
  is order-sensitive: any `passed` attempt wins; any substantive failure (a `failed` verdict or
  a crashed rework) makes the dispatch `failed` and `isError: true` even if a later verifier
  call could not complete, while error-only outcomes stay non-error with `verifierError`.
  Verifier usage is summed separately from the child's, and the verdict rides
  `displayMetadata.verification`, the envelope and `subagent_finished.verification`; no
  transcript event type was added.

## Invariants and boundaries (public API stability)

- **One turn per instance.** Overlapping `run()`/`stream()` calls are undefined behavior; use one instance per conversation, not a queue.
- **Recoverable failures are data.** Model and tool errors become inputs/results; only
  contract violations (resume preconditions, a hook throw, a context-layer rejection) surface
  as rejected promises.
- **Subagents only narrow.** Tool/capability intersection, `narrowPermission` on both axes, a
  child `riskCeiling` from its own policy, and `createSubAgentApprovalGate` denying `ask` make
  widening structural. `plan` is not dispatchable and the OS sandbox is inherited from the
  parent process — a dispatch narrows policy, not the sandbox. The SDK never picks a provider:
  `routingTiers` and `resolveSubagentModelPort` are data and a host callback.
- **Definition precedence is fixed.** built-ins < plugin < user < project; shadowed losers stay
  listed so a host can explain why an edit had no effect.
- **The public surface is the package, not the file tree.** `index.ts`, `./sse` and
  `./file-refs` are the contract; module-level exports such as `expandSkillInvocation`,
  `resolveDispatchPermission` and `createSubAgentExecutor` are internal. `0.x` carries no
  semver promise (`standalone-sdk-gateway-web` D23; the generated
  `docs/user/integrating/reference/sdk-exports.md` is the authoritative list). Packages are
  still at `0.0.1`; the release spec's `0.1.0` and `@volto/` scope are not the current state
  (`@voltojs/` is).

## Decisions and rejected alternatives (with dates)

- **2026-09-16 — typed subagents, background dispatch, depth budget**
  (`subagent-wiring-design`). Chose a `subagent_type` enum, structured results,
  `run_in_background` + `task_output`, and capability-gated `maxAgentDepth` over a recursion
  flag or a refusal after the call. The spec planned `.claude/agents` compatibility sources and
  no built-ins; the code reads only `.volto/agents` and the user directory and added built-ins
  — that is the reversal.
- **2026-10-15 — structured envelope, per-dispatch model, inheritance pin**
  (`subagent-consolidation-design`). Chose a two-text-block envelope over a new
  `{ type: "json" }` block (deferred, still not implemented), event-stream usage over a new
  event, `model` pass-through over a host whitelist, and pinned "omitted
  `tools`/`capabilities` = the parent's full set" (kept except for the browser exception).
- **2026-11-09 — parent/child trajectory provenance**
  (`subagent-trajectory-communication-design`). Chose a pre-minted `taskId` over label
  heuristics, one started/finished bracket over new background events, and
  `user_message.source` over mirroring child messages into the parent. No parent→child
  runtime message tool was added then or since.
- **2026-11-11 — dispatch permission presets** (`subagent-permission-dispatch-design`). Chose
  core-owned presets (`PERMISSION_PRESETS`, `isWiderThan`, `allowedPresetsFor`,
  `narrowToParent`), model-facing `read-only|ask|auto|full`, widening rejected before I/O, and
  `narrow(narrow(parent, dispatch), definition)`; rejected `plan` (no child plan artifact) and
  per-dispatch OS sandboxing (a process/host property). The spec's `DispatchOverrides` carried
  definition/model/tools/iterations/temperature/maxTokens and `resolveDispatchPermission`
  took the definition; the code's type has only `permission`, the function is
  `(parent, overrides)`, definition narrowing lives in `assembleSubAgent`, and it is not
  exported from the barrel — that is the reversal. Its orchestration-node half never shipped
  because orchestration was deleted the same day.
- **2026-11-11 — acceptance verification, orchestration deleted**
  (`acceptance-verification-design`). Chose verification inside the dispatch executor over a
  verifier subagent (not enforceable) or a hook gate (cannot rework), a rework in the same
  child session over a new dispatch, failure composition a verifier error cannot whiten, and
  no new transcript event type. D11 removed `createOrchestrator` and the topology types,
  which is why "orchestration" is an absence in this page.
- **2026-11-12 — release shape** (`standalone-sdk-gateway-web-design`). Chose one process on
  one port, publishing the dependency graph, ESM-only Node >= 22, and publishing the existing
  exports without an allowlist while `0.x` disclaims semver, over a dual-process Next
  deployment, a cross-origin-only web, a CJS dual build, or an early export trim.

## How to change it (tests to run, contract impact)

Run the affected package gates; never the whole repo by default and never
`@voltojs/desktop-app`:

```bash
pnpm turbo run typecheck lint test --filter @voltojs/sdk
# when the task/todo contract changes:
pnpm turbo run typecheck lint test --filter @voltojs/tools-agent --filter @voltojs/tools-plan
```

The SDK consumes built `dist` from core, runtime-node and the tool packages, so build or
include upstream packages when a cross-package type changed (`--filter @voltojs/sdk...` or
`pnpm turbo run build --filter <upstream>`). For a `packages/core` change, add
`--filter @voltojs/core` and run the replay gates.

Contract tests, by change:

| Change | Tests that pin it |
| --- | --- |
| Options/defaults, assembly, context layers, chatStore | `create-agent.test.ts`, `transcript-orchestration.test.ts`, `initial-messages.test.ts`, `config.test.ts`, `loop-default.test.ts` |
| `run`/`stream`/`resume`, HITL, cancellation, steering | `resume.test.ts`, `stream-early-break.test.ts`, `stream-channel.test.ts`, `steering.test.ts` |
| Plugin protocol/collection and wiring | `plugin.test.ts`, `plugin-agent-specs.test.ts`, `hooks.test.ts` |
| `task`/`task_output` contract and envelope | `packages/tools/agent/src/__tests__/task*.test.ts`, `subagent-envelope.test.ts`, `subagent-error-propagation.test.ts` |
| Assembly, inheritance, depth, dispatch permission, backstops | `subagent-assembly.test.ts`, `builtin-subagents.test.ts`, `agent-depth.test.ts`, `subagent-nesting.test.ts`, `subagent-permission.test.ts`, `subagent-backstop.test.ts` |
| Tier routing, provenance, isolation, parallel dispatch | `subagent-tier-routing.test.ts`, `subagent-dispatch-identity.test.ts`, `sub-agent-messages-isolation.test.ts`, `subagent-child-source.test.ts`, `subagent-e2e.test.ts` |
| Acceptance/rework | `subagent-acceptance.test.ts`, `acceptance-verifier.test.ts` |

`packages/eval/src/__tests__/{recorder,replay,simulate,trajectory}.test.ts` cover the replay
format when core inputs change.

Contract impact to check before merging:

- A new `CreateAgentOptions` field or export is a public-surface change: regenerate
  `docs/user/integrating/reference/sdk-exports.md` with `pnpm docs:gen`, update
  `docs/user/integrating/reference/sdk-api.md` and the notes JSON, then run `pnpm docs:check`.
- New subagent inputs or result fields change both `packages/tools/agent/src/task.ts` and the
  executor's `SyncSubAgentRequest`; the start bracket, tool result and envelope must stay in
  sync (one `taskId`, optional keys omitted rather than null).
- Permission behavior is a multi-package contract: presets and `narrowPermission` in
  `@voltojs/core`, the schema in `@voltojs/tools-agent`, wiring in the SDK, the badge in
  `apps/web`. A new preset goes into `PERMISSION_PRESETS`, `permissionConfigOf`,
  `allowedPresetsFor`, the task schema and the web picker together.
- A new plugin product is not wired by extending `PluginRegistry`: `createAgent` must consume
  `CollectedPlugins` and a test must prove it reaches the model. `providers`, `commands` and
  `skills` are collected but not consumed today. Verifier prompt, evidence-digest or limit
  changes touch `packages/core/src/acceptance.ts`, `acceptance-verifier.ts` and the
  failure-mode tests.

## Further reading (archive links)

- ``2026-09-16-subagent-wiring-design.md`` — typed subagents, background dispatch, depth budget.
- ``2026-10-15-subagent-consolidation-design.md`` — two-block envelope, per-dispatch model, inheritance pin.
- ``2026-11-09-subagent-trajectory-communication-design.md`` — `taskId` joins and parent/child provenance.
- ``2026-11-11-subagent-permission-dispatch-design.md`` — permission presets and the dispatch narrowing chain.
- ``2026-11-11-acceptance-verification-design.md`` — acceptance loop, failure composition, orchestration deletion.
- ``2026-11-12-standalone-sdk-gateway-web-design.md`` — publication shape, ESM-only, the `0.x` surface promise.
- Host contract and siblings: [SDK guide](../user/integrating/reference/sdk-api.md), [SDK exports](../user/integrating/reference/sdk-exports.md), [architecture.md](architecture.md), [tools-and-permissions.md](tools-and-permissions.md), [models-and-providers.md](models-and-providers.md), [sessions-and-persistence.md](sessions-and-persistence.md), [gateway-and-hosts.md](gateway-and-hosts.md).
