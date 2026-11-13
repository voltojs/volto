---
title: Sandbox and platform support
type: guide
source:
  - packages/runtimes/node/src/sandbox.ts
  - packages/runtimes/node/src/sandbox-enforcement.ts
  - apps/gateway/src/wiring.ts
generated: false
verified: 2026-11-11
---

# Sandbox and platform support

> After reading: know whether the sandbox is actually in effect on your machine, and which platforms cannot use isolation at all.

## Platform matrix

| Platform | Sandbox backend | Read-only / Ask / Auto | Full |
| --- | --- | --- | --- |
| macOS | seatbelt (the built-in `sandbox-exec`) | Full isolation | No isolation, usable |
| Linux | bubblewrap (install `bwrap` yourself) | Isolation available, a few semantics differ from macOS | No isolation, usable |
| Windows / other | None | **Refuses to start with an error** | Requires bypassing the backend check explicitly (see below); the gateway itself has no entry point |

**When the backend is missing it refuses to start explicitly, and never runs bare silently.** Better you see one error than believe there is a sandbox when there is none.

Installing bubblewrap on Linux:

```bash
# Debian / Ubuntu
sudo apt install bubblewrap
```

## "Is there a sandbox" is a runtime fact

The mode in the UI is **what you asked for**; what actually takes effect is **the backend that is running**. There is only one way to tell: look at the session's sandbox status (not at what the configuration says).

This distinction is not fussiness: there was once a bug where "the configuration said isolated but the actual command ran bare", and after that this became a rule.

## What the sandbox blocks

- **Read-only mode**: writing files, changing directories and running commands that write to disk are all refused (the refusal happens at the system-call layer, not by guessing from the command text).
- **Ask / Auto modes**: the workspace is writable; outside it isolation still applies.
- **Credentials directory**: `~/.volto` (configuration, keys, sessions) is on the read-denied list; the agent's ordinary file tools cannot read into it.

## Known gaps (more important than promises)

- **The read boundary is not a workspace fence.** The sandbox allows reading the whole disk (except `~/.volto`), so read tools can in principle bring the content of files outside the workspace back into the context.
- **Full mode is not isolated.** It simply has no sandbox, leaving only approval (and approval in Full mode is "never ask").
- **Processes started inside `bash` do not go through the network list.** `egress` applies to three network tools only.
- **Language server child processes are subject to the same sandbox and blocked from the network by default**, but in read-only mode they may be unable to write their own cache, so very large repositories get slower.
- **The TCP bridge for network filtering depends on `socat`**; when it is missing there is a warning, not a silent downgrade.

## When something goes wrong

- **Startup reports `[sandbox] No sandbox backend available on this platform`** → on Linux install `bwrap` and restart. Windows has no usable backend right now: the gateway starts in read-only mode, a missing backend refuses to start, and the UI gives you no chance to switch modes. The two ways out named in the error message (switch to `danger-full-access`, or set `failIfUnavailable: false`) are for **self-built hosts**, not UI switches.
- **A command mysteriously reports `Operation not permitted` / `Read-only file system`** → that is the sandbox working. To write that path, switch modes or switch directories, not turn the sandbox off.
- **The language server is slow in read-only mode** → it is being refused while trying to write its cache; that is the expected cost.

## Related

- [Permissions and approvals](./permissions-and-approvals.md): how to configure approvals and rules
- [Safety model](../../concepts/safety-model.md): the full threat model and what is not promised
