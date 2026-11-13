---
title: SDK guide
type: reference
source:
  - packages/sdk/src/create-agent.ts
  - packages/sdk/src/index.ts
generated: false
verified: 2026-11-11
---

# SDK guide

> After reading this you will: know how `createAgent`'s options are grouped, which methods the instance exposes, and how errors reach you.

Run through [Embed the agent in your own host](../tutorial/01-embed-agent.md) once, then come back here for the details. For the export list see [SDK exports](./sdk-exports.md).

## Lifecycle

```
createAgent(options) → AgentInstance
  .run(input)      runs one turn and returns the final state
  .stream(input)   runs while emitting events
  .steer(input)    interjects into the turn in progress (does not start a new turn)
  .updateQueue(...) rewrites or retracts messages still queued and not yet delivered to the model
  .resume(...)     resumes a suspended execution with a human decision
  .compactNow()    compacts the context once, manually
  .getState()      reads the current state snapshot
  .dispose()       releases ports and child processes
```

**Concurrency contract: one instance serves only one turn at a time.** For concurrent sessions, call `createAgent()` per session.

## Option groups

`createAgent` has many options, but they fall into four groups by "what happens if you omit them".

### Required

| Option | Notes |
| --- | --- |
| `modelPort` | The model connection. See [Ports and default implementations](../guides/ports-and-defaults.md) |

### Decide whether it can do any work

| Option | When omitted |
| --- | --- |
| `fs` / `shell` / `network` | The matching tools disappear from the visible set |
| `approvalGate` | Actions that need approval have no host to ask |
| `sandboxConfig` | No isolation |
| `capabilities` | Only the default capability set |

### Decide how restrained it is

| Option | Effect |
| --- | --- |
| `permissionConfig` | The `{ sandbox, approval }` pair; usually produced from a preset mode |
| `maxIterations` | How many "model → tool" round trips one turn may make |
| `tokenBudget` / `maxTokensPerTurn` | Context and per-turn token caps |
| `maxToolCalls` | Total tool calls allowed in one turn |
| `maxCostTokens` / `maxDollarsPerTurn` | Spending caps (requires a price table) |
| `maxWallclockMs` | Wall-clock cap for one turn |
| `maxLoopCount` / `maxLoopInterventions` | Detect the model spinning in place and intervene |
| `selfCorrectionMax` | How many turns the model gets to correct itself |
| `compaction` / `contextWindow` | When to compact and how large the window is |

Hitting these caps does not throw: the turn ends as "limit reached", and the state carries the reason.

### Decide what it remembers

| Option | Effect |
| --- | --- |
| `sessionStore` | Session state persistence |
| `chatStore` + `chatSessionId` + `chatMeta` | Conversation record persistence. `chatStore` is a **write-only** transcript (`TranscriptStore`); recovery uses the `sessionStore` snapshot or the `initialMessages` seed, not reading the transcript |
| `eventSink` | Sends process events to the UI (see [Event streams and the UI](../guides/events-and-ui.md)) |
| `memoryStore` + `embedder` | Long-term memory across sessions |
| `planStore` | Plan document storage |
| `initialMessages` / `initialTurn` / `initialStep` | Seed values when restoring from a snapshot |

### Customize its behavior

| Option | Effect |
| --- | --- |
| `systemPrompt` | The system prompt; `resolveContextLayers` / `initialContextLayers` append instruction layers |
| `tools` / `toolSources` / `plugins` | Append or replace tool sources |
| `toolVisibility: { scope, limit }` overrides the default derivation; `capabilities` narrows the visible set | See [Tool contract](./tool-contract.md) and [Tool wiring and permission policy](../guides/tools-and-policy.md) |
| `agentSpecs` / `maxAgentDepth` | Subagent definitions and nesting depth |
| `maxAcceptanceReworks` | How many reworks a dispatch with acceptance criteria gets when it falls short: default 1, max 2, 0 = verify only, no rework. The verdict call has a fixed 60-second timeout (`ACCEPTANCE_VERIFY_TIMEOUT_MS`, not configurable); a timeout is reported as `status: "error"` and does not count as a substantive failure |
| `skillRegistry` | Skill catalog |
| `routingTiers` / `model` / `providerId` / `resolveSubagentModelPort` | Model selection, tiers and subagent resolution |
| `workflowReminder` / `resolveWorkspaceReminder` | Inject the workflow mode, workspace and branch reminders |
| `hooks` / `policyEngine` | Lifecycle hooks and policy decisions |

## How errors reach you

- **A model call fails** → normalized into a `ModelError` input and fed back to the kernel; it is not thrown at you. The turn may continue or end.
- **A tool execution fails** → a `ToolResult` with `{ isError: true }` is fed back to the model, which decides how to recover.
- **A host port throws** → recorded as the error result of that tool, again without breaking the main loop.
- **`run()` / `stream()` itself throws** → only when the calling contract is violated (for example, two concurrent turns on one instance).

In other words: **recoverable errors are data, not exceptions.** This lets the loop heal itself and spares the host from writing a ton of try/catch.

## Subscribing to events

`eventSink.emit(event)` receives `{ type, data }`. At minimum handle:

| Event | When |
| --- | --- |
| `text_delta` | The model emits text |
| Tool start / end | Before / after the call (with arguments, result, duration) |
| Approval request | The host needs to show a dialog |
| `turn_end` | The turn ended, with the end reason |

Events are for the UI; **do not** treat them as the truth about state — when you need state, read `getState()`.