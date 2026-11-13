---
title: Code intelligence and databases
type: guide
source:
  - apps/gateway/src/config/lsp.ts
  - packages/runtimes/node/src/lsp.ts
  - packages/runtimes/node/src/database.ts
  - apps/gateway/src/wiring.ts
generated: false
verified: 2026-11-11
---

# Code intelligence and databases

> After reading: let the agent use language servers to look up definitions/references, and query SQLite safely.

## Code intelligence (LSP)

The gateway assembles a language server per session and exposes five tools:

| Tool | What it does |
| --- | --- |
| `lsp_definition` | Jump to a symbol's definition |
| `lsp_references` | Find every place a symbol is referenced |
| `lsp_hover` | Show type signature and docs |
| `lsp_rename` | Preview which places a rename would change (nothing written to disk) |
| `lsp_diagnostics` | Get type/syntax errors |

**The built-in support covers TypeScript / JavaScript only.** Register other languages in the `lsp` section of `~/.volto/config.json`:

```json
{
  "lsp": {
    "servers": {
      "python": { "command": "pyright-langserver", "args": ["--stdio"] }
    }
  }
}
```

Each language server needs `command` and `args`, plus an optional `initializationParams`. An invalid configuration refuses to start; when a language is not configured, the call returns a configuration snippet you can **copy as-is**, instead of making the whole session fail to assemble.

### Limits you will actually hit

- **The five tools stay visible when `typescript-language-server` is not installed**; the call returns `LSP_SERVER_MISSING` and the install command (`npm install -g typescript-language-server typescript`). Tools never silently disappear, because "missing" is harder to diagnose than "error".
- **In-flight requests cannot be cancelled.** A single request waits up to 15 seconds by default; on timeout the connection is recycled (the child process is killed) and the next call starts a new one, so one timeout does not permanently poison later calls.
- **In read-only mode the language server cannot write its own cache**, which makes very large repositories noticeably slower. That is the price of isolation.
- **Language server child processes are constrained by the session sandbox and have networking blocked by default**, and the credentials directory `~/.volto` is not readable.

## Database (SQLite)

Two tools: `db_query` (read-only) and `db_exec` (write). The write tool **exists only when the host grants write permission** — under read-only and plan modes it is not registered at all, so the model cannot see it, rather than "visible but always refused".

Three layers of constraint, all required:

1. **The path must be inside the workspace**: the database file path goes through realpath validation and anything outside is refused (fail-closed).
2. **Queries use a read-only handle**: `readonly` + `PRAGMA query_only = ON`, so write statements are refused by the SQLite engine, not pre-filtered by regex.
3. **Dangerous statements are refused explicitly**: `ATTACH` / `DETACH` / `VACUUM INTO` / `load_extension` are always refused — the read-only handle cannot stop these, yet each can escape the workspace to open an arbitrary file.

## When something goes wrong

- **All `lsp_*` calls report `LSP_SERVER_MISSING`** → install `typescript-language-server`; for non-TS/JS languages, register them in the `lsp` section first.
- **Diagnostics are very stale** → in read-only mode the language server cannot write its index cache; switch to a writable mode or wait for it to rebuild.
- **`db_query` reports "database not inside the workspace"** → move the database into the workspace, or use an absolute path and confirm it is inside the workspace.
- **`db_exec` cannot be found** → the current session is read-only or in plan mode; create a new session in a writable mode.
- **Opening a database reports a missing native module** → the host has not installed `better-sqlite3`; install it with the returned install command. This is a host dependency, not a missing agent capability.
