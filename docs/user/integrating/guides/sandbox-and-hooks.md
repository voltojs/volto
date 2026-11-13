---
title: Sandbox and hooks
type: guide
source:
  - packages/runtimes/node/src/sandbox.ts
  - packages/runtimes/node/src/sandbox-enforcement.ts
  - packages/core/src/hooks.ts
  - apps/gateway/src/config/hooks.ts
generated: false
verified: 2026-11-11
---

# Sandbox and hooks

> After reading this you will: be able to tell whether your own host is actually isolating anything, and to write a hook that really takes effect.

## Isolation happens in the wiring, not in the core

The kernel calls no sandbox. It only emits "run this command / write this file" effects, executed by the `shell` and `fs` you inject at wiring time. So:

- **`SandboxConfig` is only configuration**; `{ mode, writableRoots, ... }` describes the boundary you want.
- **The implementation is what actually isolates**: wrap `Shell` / `FileSystem` in the sandbox decorators (that is what runtime-node's `createSandboxedShell` / `createSandboxedFileSystem` are for), and the official gateway calls them during wiring.
- **The kernel's `Sandbox` port** (`run(spec)`, carrying the command, environment and `isolation: none | process | container`) is for hosts that "run commands on a separate executor"; its default implementation **throws as soon as it is called** and will never silently run bare. The official gateway does not use it.

## Telling whether there really is isolation

Read `SandboxEnforcement`, not the configuration:

| Value | Meaning |
| --- | --- |
| `full` | The backend is really in effect; out-of-bounds operations are rejected by the system |
| `partial` | Some constraints are in effect (for example, certain semantics differ on Linux versus macOS) |
| `none` | No isolation; commands run in a bare environment |

runtime-node has a dedicated enforcement module: it first distinguishes "the runner itself failed" from "the command was denied", then matches the denial signature of the backend's dialect (seatbelt → `Operation not permitted`, bwrap → `Read-only file system`).

**Do not judge isolation from "empty output" or "non-zero exit code"** — the former cannot tell "never ran" from "produced no output", and the latter cannot tell "denied" from "the command itself failed". Both have bitten this project: for three full rounds of review the sandbox was not actually in effect while the tests stayed green.

## Hooks

There are ten lifecycles. **Only three can veto and one can change a result**; the rest only observe and record:

| Lifecycle | What the return value does | When |
| --- | --- | --- |
| `preToolUse` | **Can veto** (becomes an `isError` tool result) or change the input | After permission passes, before execution |
| `postToolUse` | **Can modify** the tool result before it reaches the kernel | After the tool has executed |
| `userPromptSubmit` | **Can veto**: reject this prompt without starting a turn | After user input arrives, before the model is called |
| `preCompact` | **Can veto**: skip this compaction | After compaction is decided, before the summary is generated |
| `session:start` / `session:end` | Ignored (observe only) | Session created / ended |
| `turn:start` / `turn:end` | Ignored (observe only) | Turn starts / ends |
| `subagentStop` | Ignored (observe only, **anti-hijack**) | The subagent result returns to the parent session |
| `notification` | Ignored (observe only) | System events such as budget warnings and approval requests |

Ignoring the results of `subagentStop` and `notification` is deliberate: a subagent's output must not command the parent session, and system notifications should not become a control channel.

### The command-hook contract

A hook command receives a JSON context on stdin and expresses its decision through the exit code:

| Exit code | Meaning |
| --- | --- |
| `0` | Continue. stdout is discarded — it never reaches the model context |
| `2` | Deny; the **first line** of stderr is returned to the model as the reason |
| Any other non-zero, a failed start, a timeout | **fail-closed denial** |

A single hook times out after 10 seconds by default; on timeout it gets SIGTERM first and is then denied. stderr has a capture cap (about 64 KB); past it the stream is still read but no longer accumulated — so a hook that spams output cannot blow up the host's memory.

A `preToolUse` veto goes through the same normalization path as a permission denial: it becomes an `isError` tool result, the model tries something else and does not get stuck.

## When something goes wrong

- **You think there is a sandbox but there is not** → read `SandboxEnforcement`, not the configuration. When it is `none`, the user must know.
- **The hook does not take effect** → check the lifecycle name spelling (it must be one from the table above) and whether the exit code really returns 2.
- **The hook hangs the whole turn** → check for code that reads stdin interactively; the hook must read stdin to the end and exit on its own.
- **The model cannot see the denial reason** → observe-only lifecycles have their return values ignored; to affect the flow you must use a lifecycle that can veto.