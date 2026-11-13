---
title: Runtime and sandbox
status: current
source:
  - packages/runtimes/node/src
verified: 2026-11-13
supersedes:
  - docs/archive/superpowers/specs/2026-09-09-permission-enforcement-gaps.md
  - docs/archive/superpowers/specs/2026-09-10-security-roadmap-decisions.md
  - docs/archive/superpowers/specs/2026-09-16-shell-lifecycle-design.md
  - docs/archive/superpowers/specs/2026-10-12-lsp-db-wiring-design.md
  - docs/archive/superpowers/specs/2026-11-12-agent-browser-automation-design.md
---

# Runtime and sandbox

## Scope and where it sits

`@voltojs/runtime-node` (`packages/runtimes/node/src`) is the only layer that touches OS
resources: child processes, files, sockets, native modules. Everything above it consumes
port contracts from `packages/core/src/ports.ts` — `Shell`, `Network`, `Secrets`,
`Sandbox`, `ApprovalGate` — and never spawns anything itself.

The isolation boundary is not the `Sandbox` port. It is carried by two decorators and one
process primitive:

| Surface | Symbol | File |
| --- | --- | --- |
| File effects of the in-process fs tools | `createSandboxedFileSystem` | `sandboxed-filesystem.ts` |
| Commands (one-shot, background, persistent) | `createSandboxedShell`, `createSandboxSessionSpawner` | `sandbox.ts` |
| Arbitrary long-lived non-shell children (LSP) | `createSandboxedProcessSpawner` | `sandbox.ts` |

`createNodeSandbox` (the `Sandbox` port adapter, `sandbox.ts`) still exists and is tested,
but no production caller uses it; the SDK's default `Sandbox` throws when `run()` is
called (`packages/sdk/src/defaults.ts`). Enforcement is decorator-based, not port-based.

Wiring lives outside this package. `apps/gateway/src/wiring.ts` builds one
`SandboxConfig` triple per session in `buildSandboxConfigs(mode, cwd, deniedReadPaths)` —
`fsConfig`, `shellConfig`, `lspConfig` — and `createAgent`
(`packages/sdk/src/create-agent.ts`) turns `shellConfig` into both the wrapped `Shell` and
the persistent-session spawner, so the two can never disagree. The desktop host builds one
comparable `SandboxConfig` of its own in `apps/desktop-app/src/main/agent/wiring.ts`, used
for both the shell/session and the fs decorator: its `auto` tier is `workspace-write` +
`never` (the gateway's pair, not `danger-full-access`), and `deniedReadPaths` lists both
its own config directory (where its `electron-store` file lives) and `~/.volto`.

**Why one config feeds every shell surface.** A previous wiring revision wrapped the
`Shell` port in `wiring.ts` while `createAgent` built the session spawner from the same
config; the default (persistent-session) bash path ended up unconfined while the
isolated/background paths were sandboxed. The comment at
`apps/gateway/src/wiring.ts:578` records the fix: the raw shell is passed through and
`createAgent` derives every sandboxed surface.

## Current behavior (sandbox modes, seatbelt/bwrap, shell lifecycle, egress, secrets)

### Modes and what they select

`SandboxMode` (`packages/core/src/permission-policy.ts`) is
`read-only | workspace-write | danger-full-access`. It is one axis of
`PermissionConfig`; the other is `ApprovalPolicy`. `PERMISSION_PRESETS`
(`permission-presets.ts`) maps the product presets onto it: `read-only` and `plan` →
`read-only`, `ask` and `auto` → `workspace-write`, `full` → `danger-full-access`. The
gateway's unknown-state default is `read-only` (`apps/gateway/src/server.ts:703`).

The mode selects a *writable range*, nothing else:

- `danger-full-access` returns the shell unchanged (a copy carrying
  `sandboxEnforcement: "none"`) and a bare `/bin/bash -s` session spawner. No isolation.
- `read-only` and `workspace-write` select a backend. Both backends still allow reads of
  the whole filesystem except `deniedReadPaths`.
- `read-only` ignores `writableRoots` / `readOnlyOverlays` entirely in both profile
  builders (`buildSeatbeltProfile`, `buildBwrapArgs`), even though the gateway hands the
  same roots to every mode.

Per-mode config as the gateway builds it (`buildSandboxConfigs`):

- `writableRoots: [cwd, "/tmp", os.tmpdir()]` for every mode (both temp spellings: on
  macOS `os.tmpdir()` is not `/tmp`).
- `readOnlyOverlays: []` — deliberately no `.git` / `.env` carve-outs (see Decisions).
- `deniedReadPaths: [<config dir realpath>]`, i.e. `~/.volto`.
- `shellConfig` additionally sets `network: { enabled: true }` and
  `strippedEnvPatterns: SECRET_ENV_PATTERNS`; `lspConfig` gets the same env stripping but
  keeps network disabled; `fsConfig` has no network or env concept.

The adapter's own defaults differ from the gateway's policy: with nothing supplied and
`workspace-write` selected, `createSandboxedShell` uses `writableRoots = [process.cwd(),
tmpdir()]` and `readOnlyOverlays = [".git", ".env"]`. Only callers that omit the fields get
the overlays.

### Backends

`detectBackend()` maps `darwin → seatbelt`, `linux → bubblewrap`, everything else →
`none`. `probeBinary()` (`which`, cached per name in `probeCache`) decides whether the
runner exists; the cache is process-lifetime, which is why the LSP manager uses its own
uncached probe instead.

**Seatbelt** (`buildSeatbeltProfile`). The profile is written to
`<tmpdir>/volto-sandbox-<pid>-<n>.sb` and passed with `-f` (a profile *file*), never `-p`
(an inline profile *string*). Both builders are fed `realpath`-resolved writable roots and
denied paths (`resolveRealRootPath`), because seatbelt matches real paths and on macOS both
`/tmp` and `os.tmpdir()` are symlinks — a profile built from the lexical spelling denies
every write under it. The baseline allows reads of `/`, metadata reads,
`sysctl-read`, `signal`, `ipc-posix*`, `process-exec` over `/`, `process-fork`, three
`mach-lookup` services (`system.dylib`, `com.apple.bsd.dirhelper`,
`com.apple.system.opendirectoryd.libinfo`), and writes under `/dev`. Each writable root
adds `(allow file-write* (subpath ...))`; each overlay adds a later `(deny file-write*)`;
each denied read path adds `(deny file-read-data ...)` **and**
`(deny file-read-metadata ...)` — the wildcard form `file-read*` was verified on-host to
silently no-op.

**Bubblewrap** (`buildBwrapArgs`). `--ro-bind / /`, `--dev /dev`, `--proc /proc`, then
`--bind <root> <root>` per writable root, `--ro-bind-try <overlay> <overlay>` per overlay
(`-try`, not plain `--ro-bind`: a scratch workspace has no `.git`, and the hard form aborts
the whole invocation as an infrastructure failure), `--tmpfs <denied path>` per denied read
path, `--unshare-net` when network is disabled, and `--die-with-parent`.

Backend asymmetry is deliberately not smoothed over. Reads denied by seatbelt are
*refused*; the bwrap equivalent *masks* the path with an empty tmpfs, so a process that
already holds an fd keeps reading and the directory still appears (empty). The code marks
this `PARITY NOTE` at `buildBwrapArgs`.

**Fail-closed construction.** `failIfUnavailable` defaults to `true`: a confining mode on a
platform with no backend throws at construction. With an explicit `false`:

- no backend at all → `createSandboxedShell` / `createSandboxSessionSpawner` warn once and
  run **unconfined** (env stripping still applies); `createSandboxedProcessSpawner`
  returns `undefined` instead, because its callers hold a long-lived child and have no
  confined fallback;
- backend selected but its runner binary missing → the shell and session spawners still
  construct (`sandboxEnforcement: "none"`) but every `exec` yields an
  `[sandbox] INFRASTRUCTURE FAILURE:` stderr line and exit code `126`
  (`missingRunnerEvents`); launch throws; the process spawner returns `undefined`.

**Enforcement is a runtime fact.** `sandboxEnforcement: "full" | "partial" | "none"` is
attached to `SandboxedShell` and `SandboxedFileSystem`. Both backends report `"full"` when
their runner is present and `"none"` otherwise; the fs decorator reports `"full"` unless
the mode is `danger-full-access`. `"partial"` is declared
(`sandbox-enforcement.ts`) but no code path produces it.

**Runner failure vs denial.** `classifyRunnerFailure` matches per-backend
`RUNNER_FAILURE_RULES` against stderr lines (informational lines such as
`bwrap: Creating new namespace` are subtracted first) and only on a non-zero exit;
`withRunnerFailureClassification` buffers stderr and inserts the infrastructure-failure
line before the exit event. `DENIAL_SIGNATURES` records each backend's denial dialect
(seatbelt `operation not permitted`; bwrap `read-only file system` / `permission denied`)
but is consumed by tests only — production code classifies runner failure, not denials.

### Shell lifecycle

`createNodeShell` (`shell.ts`) spawns `shell: true` with `detached:
DETACHED_ON_POSIX`, drains stdout and stderr into one queue concurrently (the pipe-buffer
deadlock fix), and terminates through `killProcessTree` (`process-kill.ts`: the process
group, falling back to the direct child), SIGTERM first and SIGKILL after a 2 s grace,
escalation keyed on `closed` rather than `child.killed`. The exit event carries
`timedOut: true` only when this adapter's own timer fired — an external `abortSignal` kill
keeps the plain shape.

Two facilities, deliberately not one (`2026-09-16` spec §5, corrected `2026-09-17`):

- **Background processes** — `createProcessRegistry` (`process-registry.ts`): independent
  spawns, cap `DEFAULT_MAX_BACKGROUND = 8`, id `bg-<n>-<pid>`, per-process ring buffer
  (`DEFAULT_PROCESS_BUFFER_BYTES = 256 * 1024`) with cursor reads and an overflow note,
  `killProcess` / `disposeProcesses` through `killProcessTree`.
- **Persistent session** — `createPersistentSession` (`persistent-session.ts`): one
  long-lived `bash -s` per agent (the SDK's `getSession()` singleton), commands written to
  stdin, completion detected by a per-command random sentinel
  `__VOLTO_DONE_<nonce>:<rc>:<pwd>` scanned per stdout chunk (never end-anchored, so a
  background writer cannot turn a finished command into a phantom stuck one). Both streams
  are retention-capped at `DEFAULT_SESSION_BUFFER_CHARS = 256 * 1024` with dropped
  characters disclosed. `cwd` is applied as a subshell (`(cd '…' && cmd)`) and never moves
  the session; a genuine `cd` is reported via `cwdAfter` / `cwdChanged` compared on
  physical paths. A timeout escalates SIGINT → 2 s grace → SIGKILL → respawn, returning
  `exitCode: 124`, `timedOut: true` and a `stateResetReason` the tool must surface.

Routing happens in `createBashTool` (`packages/tools/shell/src/bash.ts`):
`run_in_background` + `shell.launch` → background; otherwise the persistent session unless
`isolated`; otherwise one-shot `exec`. Output is capped at 100 000 characters
(`show_full_output` opts out). Default per-call timeout is `DEFAULT_TIMEOUTS.tool = 120 s`
(`packages/tools/common/src/timeout.ts`); the session's own default (30 s,
`SHELL_SESSION_DEFAULT_TIMEOUT_MS`) is overridden by the tool's explicit value. When a
sandbox exposes no `launch`, background mode falls back to the session/foreground path and
says so in `modelContent`.

### Sandboxed egress (inside a shell/session)

`SandboxNetworkConfig.enabled` is an on/off rule in both backends
(`(allow|deny network*)` / `--unshare-net`); host filtering exists only when
`network.enabled === true` **and** `allowedHosts` is non-empty. In that case
`createSandboxProxy` listens on a unix socket, `socat` bridges `127.0.0.1:<port>` to it,
and the child gets `http_proxy` / `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` injected. The
lowercase `http_proxy` is required: curl ignores uppercase `HTTP_PROXY` for plain `http://`
URLs, which would bypass the allowlist. The proxy accepts `CONNECT` only, exact host or
`*.example.com` wildcard suffix, and returns 403 otherwise.

The shell spawner starts the proxy lazily on first use; the session spawner starts it
eagerly at construction (its `spawn()` is synchronous) and each session gets its own socat
bridge, killed by the session's `cleanup`. The bridge binary defaults to `socat` and is
overridable with `socatBinary`. **A missing bridge is refused, not warned about**: the
shell and session spawners throw at construction, `launch` throws, a per-`exec` re-check
(the bridge can disappear after construction) emits an `[sandbox] INFRASTRUCTURE FAILURE:`
line with exit code `126`, and `forSession()` throws. Running on without the proxy would
leave the allowlist silently unenforced.

`createSandboxedProcessSpawner` refuses to build at all when `allowedHosts` is non-empty,
because it builds no proxy and the backend rule cannot filter hosts. The LSP config carries
no `network` block, so its children are simply network-denied.

### Egress as a tool-level policy (the `Network` port)

`wrapNetworkWithEgress` (`egress.ts`) wraps a `Network` and answers denied requests with
`403` plus a JSON `egress_denied` body — it never throws. Matching is exact,
case-insensitive hostname; `denyHosts` beats `allowHosts`; a malformed URL denies. The
gateway applies it to the `Network` port it passes to `createAgent`, i.e. `web_fetch`,
`web_search`, `http_query` and the browser host's navigation policy. It does **not** see
the model's own transport, and it does not see anything a bash child launches.

`createNodeNetwork` (`network.ts`) is a plain `fetch` wrapper: 30 s default timeout, the
shared `[timeout] <subject> timed out after <n>ms` signature for its own timer, and
`AbortError` identity preserved for caller aborts.

Policy source is the unified `config.json` `egress` section, with the legacy `egress.json`
still read through the config store's migration fallback
(`apps/gateway/src/config/store.ts`). A malformed policy refuses the session build rather
than running without it.

### Secrets and environment stripping

`createNodeSecrets` (`secrets.ts`) resolves a ref from an in-memory map, then from
`SECRET_<REF>` (non-alphanumerics → `_`), and honours an optional `allowedRefs` scope.
It has **no production caller**: the SDK default `Secrets` resolves everything to
`undefined`, and no host injects the Node adapter.

Credential protection is therefore entirely environment stripping plus the read fence:
`stripEnvFrom` (shell) and `buildStrippedEnv` (spawned children) rebuild the environment
from `process.env` minus `strippedEnvVars` and minus names matching `strippedEnvPatterns`
(regex `lastIndex` reset before every test so `/g` patterns behave). The gateway's
`SECRET_ENV_PATTERNS` (`apps/gateway/src/wiring.ts`) cover `API_?KEY`, `*_KEY`, `TOKEN`,
`SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL`. `SSH_AUTH_SOCK` is knowingly kept so
`git push` works; `~/.ssh`, `~/.aws`, `~/.kube` stay readable.

## Auxiliary subsystems (LSP, SQLite, browser)

### Language servers

`createNodeLspManager` (`lsp.ts`) keeps one lazy child per language per session, spawned
through `createSandboxedProcessSpawner(opts.sandbox ?? { mode: "danger-full-access" })`.
Command and args go to the runner as argv — no shell, no quoting. With no sandbox config
the child is unconfined (the SDK default); the gateway passes `lspConfig` whenever a
sandbox mode is set, which denies network, strips secret-shaped env vars and denies
`~/.volto`.

Other behaviour that matters:

- The executable probe is injected and uncached (`defaultProbe`: `X_OK` for absolute
  paths, `which` for bare names), so installing a server mid-session recovers on the next
  call. `probeBinary`'s module-level cache is why this is a separate probe.
- Path handling: `fs.resolvePath` first (so `deniedReadPaths` applies), then a realpath
  containment check. Anything outside `workspaceRoot` is `LSP_PATH_OUTSIDE_WORKSPACE`; an
  unconfigured language is `LSP_LANGUAGE_UNCONFIGURED` (the tools turn it into a
  copy-pasteable config snippet).
- Document sync is full-sync: `didOpen` with version 1 before the first request,
  `didChange` with an incremented version after a write, serialized per URI so concurrent
  callers cannot double-open.
- Diagnostics are pull-first (`textDocument/diagnostic` when `initialize` advertised
  `diagnosticProvider`) else the push cache; "nothing reported yet" and "zero diagnostics"
  are different reports.
- A request timeout (15 s default) reaps the server and rejects; the timed-out request is
  **never replayed**. A crash that kills the connection before an answer is replayed once
  on a fresh, re-synced server; a second crash marks the language `unavailable` for the
  session. In-flight requests cannot be cancelled otherwise.
- Idle reclaim is driven by the injected `Clock` plus `sweepIdle()`; production runs an
  unref'd interval at half the budget (10 min default). `dispose()` reaps live, booting and
  still-handshaking children and only resolves when they are gone.

### SQLite

`createSqliteDatabaseOpener` (`database.ts`) is in-process, so the sandbox does not apply;
its boundary is three explicit rules:

1. The requested path goes through the session `FileSystem` (`fs.resolvePath`, so the
   credential-dir fence applies) and then `realResolve`; it must land inside
   `workspaceRoot`, else `DatabasePathError`. Containment is re-checked independently when
   the fs refusal was about something else, so a sandbox denial is not relabelled as a
   workspace rule.
2. Read-only handles are opened `{ readonly: true, fileMustExist: true }` and pinned with
   `PRAGMA query_only = ON`. `journal_mode` is never set — WAL is sticky in the header and
   a read-only query must not leave `-wal` / `-shm` behind.
3. `ATTACH`, `DETACH`, `VACUUM INTO` and `load_extension` are refused keyword-level after
   string literals and comments are stripped. `query_only` covers none of them (probed:
   `ATTACH` and `VACUUM INTO` still run on a read-only handle). A plain `VACUUM` stays
   allowed. The comment states the assumption that this set is SQLite's whole
   file-touching surface, so a new SQLite feature is a documented revisit, not a silent
   hole.

Handles are cached by `(realpath, readonly)` and closed by `closeAll()`. `db:write` is
granted only when the host says so (`db:write` capability absent ⇒ `db_exec` is never
registered); the gateway derives `allowWrite = sandboxMode !== "read-only"`.
`better-sqlite3` is a lazy optional import whose failure message carries the install
command.

### Browser

`createNodeBrowserHost` (`browser-host.ts`) drives the user's installed
Chrome/Chromium/Edge through Playwright (`playwright-core` is a driver; no bundled
browser). The gateway constructs one host per process and hands each chat session
`browserHost.page(sessionId, { egressPolicy })`.

- Executable resolution (`browser-executable.ts`): a configured path wins even when it does
  not exist (reported as a configuration error rather than silently launching another
  browser); otherwise the first system install per platform. No executable ⇒
  `BrowserUnavailableError` and the browser tools are not registered at all.
- `resolveHeadless` defaults to **headed**, except Linux without `DISPLAY` /
  `WAYLAND_DISPLAY`, which runs headless with a warning. The gateway config defaults
  `browser.headless` to `true` (`apps/gateway/src/config/browser.ts`), so gateway sessions
  are headless in practice; its file comment states the same default.
- Lifecycle: one Chromium per host (lazy `chromium.launch`), one `BrowserContext` + `Page`
  per session, at most 4 live contexts (LRU eviction), 600 s idle close, and — in the
  gateway — the session's context is closed at the end of every turn
  (`apps/gateway/src/sessions.ts:2102`), which makes the browser turn-scoped regardless of
  the idle timer. Per-page actions are serialized (`createSerialQueue`).
- Navigation policy (`isNavigationAllowed`, installed with `context.route("**/*")`) applies
  to **top-level navigation requests only**: `http`/`https`/`about:blank`, no embedded
  credentials, no cloud-metadata or link-local hosts (`169.254.0.0/16`,
  `100.100.100.200`), and the egress allowlist when one is configured. Sub-resources and
  page-initiated JS requests are not filtered.
- Diagnostics keep two 200-entry rings — console/pageerror, and requestfailed plus ≥400
  responses — returning the last 50 by default and never capturing response bodies.
  `storageState("save")` writes to the configured path only, directory `0700` and file
  `0600`, and returns the path and timestamp, never cookie values. There is no download,
  upload or `browser_evaluate` tool; the host never sets `acceptDownloads`, so Playwright's
  own default applies.

## Invariants and boundaries (what enforcement actually is)

- **The boundary governs file effects.** Network egress, process visibility, CPU, memory
  and file descriptors are outside the mode vocabulary. `read-only` bounds writes, not
  reads.
- **Egress is a tool-level allowlist, not a firewall.** Bash children and the model's own
  transport are outside it; a configured `allowedHosts` is enforced only for
  `web_fetch`/`web_search`/`http_query` and browser top-level navigation, plus shell
  children through the sandbox proxy — and a missing `socat` refuses the spawner rather
  than running them unfiltered.
- **Enforcement must be read from `sandboxEnforcement`, never from `config.mode`.**
  Every sandbox test does this. The fact is attached to the adapter object only: `createAgent`
  widens the shell to `Shell` and the gateway widens the fs to `FileSystem`, no host reads
  it, and `GET /gateway-info` reports configuration (e.g. `lsp: <configured>`) rather than
  runtime enforcement.
- **Refusals are events, never throws, on the shell path.** A sandboxed `exec` reports
  denials as stderr + exit; a missing runner reports infrastructure failure + exit 126. The
  fs decorator throws `SandboxBoundaryError`, which the fs tool layer turns into
  `isError: true`.
- **Construction is fail-closed for a confining mode**: no backend, or a selected backend
  whose runner is missing, throws unless the caller explicitly opted out; the process
  spawner prefers `undefined` over an unconfined child.
- **Check-then-act (TOCTOU) is shared by both decorators.** `assertWritable` resolves the
  target and then hands the path to the inner fs; the shell boundary check and the spawned
  child are likewise two steps. Both files document this rather than implying atomicity.
- **`bash` remains the upper bound of the whole model.** It is free text, so per-tool
  permission grading is a ceiling on named tools, not a guarantee; `SAFETY.md` states this
  and the known escapes (e.g. a hook script planted in the workspace).
- **The workspace `.volto/spill/` and the credential dir `~/.volto` are different
  things** and must never be merged: spill data must stay readable, credential data must
  not.
- **The `Sandbox` and `Secrets` ports are placeholders today.** `createNodeSandbox` writes
  its generated seatbelt profile to a temp file, passes it with `-f`, and deletes it after
  the run; it implements only `seatbelt` / `none`, so an explicitly requested `landlock` or
  an auto-detected bubblewrap throws instead of falling through to an unisolated bare
  spawn. It still does no runner-failure classification and keeps the `EGRESS_HOST` env
  hack, and `createNodeSecrets` is likewise exported and tested but not wired; treating
  either as the real boundary would be wrong.

## Decisions and rejected alternatives (with dates)

**2026-09-09 — the sandbox governs file writes only; network is not part of it.**
The gateway began enabling the shell sandbox and broke `npm install`, `curl` and every
`git` write; the ruling was to pass `network: { enabled: true }` explicitly and drop the
shell-side `.git` read-only overlay, leaving write policy to risk tiers
(`2026-09-09-permission-enforcement-gaps.md` §C5). Rejected: keeping `.git`. That overlay
was tried twice and removed twice, on the argument that it protects one path while every
other execute-later target stays writable (`apps/gateway/src/wiring.ts:414`).

**2026-09-09 — `sandbox-exec` was invoked with `-p` and a profile path** since Plan 009;
every macOS sandboxed command exited 65 with `unbound variable`, and the tests stayed green
because none of them ran a real command. Fixed to `-f`; `sandbox-enforcement.ts` exists to
make "the runner never ran" a detectable state.

**2026-09-09/10 — no command-content classifier.** Rejected because it blocks naive
attacks but not deliberate evasion while creating the impression it blocks them; the threat
model is "the model makes a mistake", with induced-model defence delegated to a disposable
VM (`2026-09-10-security-roadmap-decisions.md` §1.2). The same decision keeps `~/.ssh`
readable (§1.5) and keeps `deniedReadPaths` limited to the credential directory, whose
justification is closed-loop privilege escalation.

**2026-09-10 — adopt `SandboxEnforcement` and separate runner failures from denials.**
"Decorator present ⇒ sandbox effective" was the posture that hid the `-p` defect; the
replacement is a self-reported enforcement level plus per-backend failure rules (§2.1,
§2.2). `partial` was part of that vocabulary and still has no producer. The same period
rejected a loopback carve-out in the seatbelt network rule: a
`(deny network* (remote ip "localhost:*"))` rule was added to keep sandboxed commands off
the gateway's control plane, on-host probing showed it degrades into "deny everything", so
it was reverted and the control plane is protected at the route instead
(`buildSeatbeltProfile` comment; do not re-add).

**2026-09-16/17 — the sandbox wraps the long-lived process, not each command.**
Profile lifetime moved from per-exec to per-process so `launch` and the persistent session
work under confinement instead of existing only in `danger-full-access`. Also decided: a
persistent session by default (`isolated: true` as the escape hatch), a random sentinel
nonce, subshell `cwd`, a 256 KB ring buffer, and separate facilities for background
processes and sessions. The draft's "one shared registry" was corrected on 2026-09-17; the
two shapes do not compose (`2026-09-16-shell-lifecycle-design.md` §5). **Reversal:** the
earlier decision to *remove* `launch` under a sandbox (C4) is gone — `launch` is
implemented and sandboxed.

**2026-10-12 — LSP children live under the session sandbox; sqlite does not.**
Rejected: documenting LSP as outside the sandbox, and splitting LSP out of the task. LSP
gets the same config minus network ("a language server has no business reaching the
network"), and sqlite is handled in-process with realpath containment + engine-level
read-only + keyword refusals. In-flight request cancellation was descoped to a request
timeout. **Reversal:** the spec expected a crashed in-flight request to be rejected; the
code replays it once on a fresh server, while a timed-out request is still never replayed.

**2026-11-12 — the agent's browser is its own; no user-visible panel and no user browser
takeover.** Playwright plus the user's installed Chromium, one context per chat session,
no `browser_evaluate`, and page content treated as untrusted
(`2026-11-12-agent-browser-automation-design.md` D1–D10). The spec's `headless: true`
default is only true at the gateway config layer: the adapter defaults to headed except on
a display-less Linux host.

## How to change it (tests to run, platform-specific gates)

Static gate for this package and the host that wires it:

```bash
pnpm turbo run typecheck lint test --filter @voltojs/runtime-node
pnpm turbo run typecheck lint test --filter @voltojs/gateway
```

Add `--filter @voltojs/sdk` when a port shape or a `SandboxConfig` field changes, and
build upstream packages first (`pnpm turbo run build --filter @voltojs/runtime-node`) since
`tools-*` / `sdk` consume `dist`.

Suites that must stay green when touching the boundary:

| Area | Tests |
| --- | --- |
| Profiles and spawners | `sandbox.test.ts`, `sandbox-enforcement.test.ts`, `sandboxed-process.test.ts` |
| Shell and sessions | `shell-adapter.test.ts`, `shell-e2e.test.ts`, `persistent-session.test.ts`, `persistent-session-cwd.test.ts`, `sandbox-session.test.ts` |
| Background and teardown | `process-registry.test.ts`, `process-kill.test.ts`, `process-buffer.test.ts`, `background-drain.test.ts` |
| fs fence | `sandboxed-filesystem.test.ts`, `read-bytes-sandbox.test.ts`, `fs-tool-executor.test.ts` |
| Egress and secrets | `egress.test.ts`, `network-adapter.test.ts`, `network-e2e.test.ts`, `secrets.test.ts` |
| Auxiliary | `lsp-manager.test.ts`, `lsp-lifecycle.test.ts`, `lsp-diagnostics.test.ts`, `sqlite-opener.test.ts`, `browser-host.test.ts`, `browser-host.e2e.test.ts` |

Rules for new assertions (they encode the three-round failure):

- Assert the **denial itself** — non-zero exit **plus** that backend's dialect. Never
  assert "empty output": a sandbox that never ran, a typo, and a crashed runner all produce
  empty output.
- Assert runner failure *before* denial; `classifyRunnerFailure` returning non-null means
  nothing executed.
- Never union dialects across backends. Seatbelt produces `Operation not permitted`; bwrap
  produces `Read-only file system` (`permission denied` via Landlock paths).
- Read `sandboxEnforcement`, never `config.mode`, for "is it sandboxed".
- Platform-specific tests are skipped explicitly: `itDarwin`, `itLinux`, `itBwrap`,
  `itUnlessWindows`, `itPosix`. A skip is not a pass; do not let a missing runner read as a
  denial.
- This package's vitest config raises `testTimeout` / `hookTimeout` to 30 s because the
  suites drive real children (`packages/runtimes/node/vitest.config.ts`).

When adding a child-process surface: reuse `createSandboxedProcessSpawner` (argv, no shell)
or `createSandboxSessionSpawner` (stdin protocol). Do not spawn bare under a confining
mode, do not bypass `buildStrippedEnv`, and pass `deniedReadPaths` through. When adding a
backend: extend `SandboxBackendName`, `RUNNER_FAILURE_RULES` and `DENIAL_SIGNATURES`, add
the profile/args builder, and report `"partial"` if it cannot govern every promised effect.
When changing what a mode may write, change it in `buildSandboxConfigs` so the fs, shell
and LSP configs move together; a change in only one of them reopens the unconfined-default
bash bug.

## Further reading (archive links)

- `SAFETY.md` — threat model, boundary strength, known non-protections.
- Module pages: [index](README.md), [architecture](architecture.md),
  [tools and permissions](tools-and-permissions.md),
  [gateway and hosts](gateway-and-hosts.md).
- Archive: `shell lifecycle`,
  `permission enforcement gaps`,
  `security roadmap decisions`,
  `LSP/DB wiring`,
  `agent browser automation`.
- Code entry points: `packages/runtimes/node/src/sandbox.ts` (`createSandboxedShell`,
  `createSandboxSessionSpawner`, `createSandboxedProcessSpawner`, `buildSeatbeltProfile`,
  `buildBwrapArgs`), `sandbox-enforcement.ts`, `sandboxed-filesystem.ts`, `shell.ts`,
  `persistent-session.ts`, `process-registry.ts`, `process-kill.ts`, `egress.ts`,
  `sandbox-proxy.ts`, `lsp.ts`, `database.ts`, `browser-host.ts`.