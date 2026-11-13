---
title: Safety model (user edition)
type: concept
source:
  - SAFETY.md
  - packages/runtimes/node/src/sandbox.ts
generated: false
verified: 2026-11-11
---

# Safety model (user edition)

> After reading this you will: know what these boundaries actually stop, and what they do not promise at all.

## In one sentence

The sandbox and approvals guard against **the model making a mistake** — deleting the wrong file, running a command in the wrong directory. They **do not promise** to stop **the model being induced**: a malicious README in the repository or a carefully crafted instruction on a web page can make the agent do something you did not want.

This distinction is not a disclaimer; it determines how you should use it.

## What they actually stop

| Mechanism | What it stops | Where the boundary is |
| --- | --- | --- |
| Sandbox | Writing files outside the workspace, damaging system directories, writing to disk in Read-only mode | It is syscall-level isolation; Full mode has none |
| Approvals | Actions that need your sign-off really stop and wait for you | Only for tools that declare a path / URL / command argument |
| Permission rules | Tightening specific paths, hosts and command prefixes | They can only tighten; `bash` is not bound by path rules |
| Network egress allowlist | The three network tools reaching unauthorized hosts | It does not block a `curl` run inside `bash` — it is not a firewall |
| Credential isolation | The agent's file tools cannot read `~/.volto` (keys, config) | The read boundary is not a workspace fence: files outside the workspace are readable in principle |

## What it explicitly does not promise

- **It does not promise to stop induced behavior.** Command content is not classified as "dangerous" — the illusion of protection is more dangerous than not doing it.
- **It does not promise a workspace fence.** There is no extra restriction on the read side; the whole disk is readable (except the credentials directory).
- **It does not promise a total network block.** Only those three network tools go through the allowlist.
- **It does not promise that Full is safe.** Full means no sandbox and no approvals; use it only for tasks you fully trust.

## So how should you use it

1. **Use Ask mode by default**, and keep a human in the loop.
2. **Do not run untrusted tasks in a directory that holds production credentials** — this is the only reliable measure, because it does not depend on any mechanism being correct.
3. **Read the approval card before you click.** What the card says is what will run; if you do not understand it, do not allow it.
4. **Use rules to reduce repeated interruptions** (things like `pnpm test`); do not use them to "loosen" a boundary — they cannot.

The full threat model and the case-by-case reasoning are in [`SAFETY.md`](https://github.com/voltojs/volto/blob/main/SAFETY.md) at the repository root.

## Extra boundaries for code intelligence and databases

The language server (`lsp_*`) and sqlite (`db_query` / `db_exec`) each have a boundary independent of the shell that deserves its own explanation:

- **The language server child process is subject to the same sandbox and its network is blocked by default**; the credentials directory `~/.volto` is unreadable, and environment variables matching `*API_KEY*` / `*TOKEN*` / `*SECRET*` are stripped. Under Full mode it is equally unisolated.
- **But the read scope is still the whole disk** (except the credentials directory); in principle `lsp_hover` and diagnostics can bring back the contents of files outside the workspace.
- **In Read-only mode the language server cannot write its own caches**, and very large repositories get slower — that is the price of isolation.
- **In-flight requests cannot be cancelled**: a timeout (15 seconds by default) reclaims the connection and kills the child process; the next call starts a fresh one, so later calls are not permanently affected.
- **Languages other than TS/JS have no built-in mapping** and must be registered in the `lsp` section; when a language is not registered, calls return a copyable config snippet instead of failing the build.
- **sqlite is an in-process handle the sandbox cannot reach**, so three more constraints apply: the database file path must stay inside the workspace (a realpath check rejects anything outside); `db_query` uses a read-only handle, so SQLite rejects write statements rather than relying on text pre-filtering; `ATTACH` / `DETACH` / `VACUUM INTO` / `load_extension` are rejected explicitly — a read-only handle does not stop them, yet all of them can open arbitrary files outside the workspace.
- **`db_exec` exists only when the host grants write permission**: when writing is not allowed it is not registered at all, so the model cannot see it, instead of being "visible but always rejected".
- **`better-sqlite3` is a native module**: when it is not installed, the first open returns installation instructions; it neither crashes at build time nor degrades silently.