---
title: Ports and default implementations
type: guide
source:
  - packages/sdk/src/defaults.ts
  - packages/core/src/ports.ts
generated: false
verified: 2026-11-11
---

# Ports and default implementations

> After reading this you will: know which ports you must implement yourself, which can stay on their defaults, and what happens when you omit them.

## One principle

The kernel never touches I/O. Time, randomness, IDs, files, commands, network and storage are all **injected ports**. The payoff of this constraint: the same input sequence produces an identical `(state, effects)` twice, so it can be recorded and replayed, snapshot-tested, and moved to another host.

The cost: **for a port you do not pass, the capability really does not exist** — not an "error", but the matching tool vanishing from the set the model can see.

## Grouping

### The ones you must face (they decide whether the agent can do any work)

| Port | When omitted | Suggested implementation |
| --- | --- | --- |
| `modelPort` | **Required**; cannot be constructed without it | Use `createPiAiModelPort` / `createOpenAIModelPort` / `createAnthropicModelPort`, or implement `stream(ModelRequest)` yourself |
| `fs` | File tools (read, write, search, glob) are invisible | Use it together with the sandbox decorator, see below |
| `shell` | Command tools such as `bash` are invisible | The persistent session hangs off it; do not make a new process per command |
| `network` | Network tools are invisible | You decide the egress policy in your implementation |
| `approvalGate` | The default gate always returns `allow`: actions that need approval **never actually ask you** and are let through | Your host's dialog implementation |

### Ones with defaults you can add later

| Port | Default behavior |
| --- | --- |
| `clock` / `id` / `random` | Real time, an incrementing + timestamp id, `Math.random` |
| `tokenizer` | Estimates from character count (good enough, not exact) |
| `sessionStore` | In memory, lost when the process ends |
| `chatStore` (the transcript implementation) | Does not persist: the conversation record never hits disk |
| `eventSink` | Discards every event |
| `memoryStore` / `embedder` | The memory store is an in-memory implementation; calling `embedder` throws |
| `telemetry` / `auditSink` | No-op implementation |
| `sandbox` | Calling it throws: it explicitly requires you to inject a real implementation (it will not silently run bare). Note that isolation is actually the responsibility of the `fs` / `shell` implementations, see below |
| `secrets` | Every lookup returns `undefined` (treated as no such secret) |
| `scheduler` | No-op: `sleep` returns immediately and `schedule` is fire-and-forget |
| `policyEngine` | Always returns `allow` (equivalent to no policy) |

## Read the sandbox together with the filesystem

`fs` and `shell` are your own implementations, so **the sandbox is not automatic**. The kernel never calls the sandbox: it emits an "execute command" effect and your injected implementation does it. The right approach is to wrap them in the sandbox decorators — that is what runtime-node's `createSandboxedShell` / `createSandboxedFileSystem` do, and the official gateway calls them during wiring.

`SandboxConfig` is only configuration. **"There is a sandbox" is a runtime fact**: if your implementation ignores it, this session has no sandbox, and the `sandbox` port may still hold the default implementation — it throws as soon as it is called and will never silently run bare.

## The event stream is the host's UI contract

Every event `eventSink` receives is meant for the UI: text deltas, tool calls and results, approval requests and decisions, context reminders, turn end (token usage rides on `assistant_message`). The official Web UI is the consumer of these events.

For your own UI, copy this event set rather than reading the final state — the final state tells you the outcome, not the process.

## When something goes wrong

- **A tool vanished for no reason**: first check whether the matching port was omitted (visibility is tied to capability).
- **Tests are flaky**: check whether real time / randomness is in play — inject a fixed `clock` / `random` and it becomes replayable.
- **Two sessions pollute each other**: `createAgent` is serial per turn; for concurrency, use one instance per session.