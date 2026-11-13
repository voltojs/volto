---
title: Security
status: current
source:
  - SAFETY.md
  - packages/core/src
  - packages/runtimes/node/src
  - apps/gateway/src
verified: 2026-11-13
supersedes:
  - docs/archive/superpowers/specs/2026-09-09-security-architecture-analysis.md
  - docs/archive/superpowers/specs/2026-09-09-permission-enforcement-gaps.md
  - docs/archive/superpowers/specs/2026-09-10-security-roadmap-decisions.md
  - docs/archive/superpowers/specs/2026-09-20-parameter-permission-rules-design.md
  - docs/archive/superpowers/specs/2026-10-12-lsp-db-wiring-design.md
  - docs/archive/superpowers/specs/2026-10-17-hooks-host-surface-design.md
---

# Security

## Scope and where it sits

`SAFETY.md` is the normative position: what volto defends, what it explicitly does
**not** defend, and how strong each boundary really is. This page does not restate or
soften those claims. It is the implementation map — for each promise in `SAFETY.md`,
which symbol enforces it and where the code is narrower or wider than the sentence sounds.

Mechanics live in sibling pages and are linked rather than repeated:
[runtime and sandbox](runtime-and-sandbox.md) (backend profiles, spawners, shell
lifecycle, LSP/SQLite/browser internals), [tools and permissions](tools-and-permissions.md)
(tool contract, router, presets, approval transport), [gateway and hosts](gateway-and-hosts.md)
(routes and host differences).

| Layer | Owns security-wise | Entry point |
| --- | --- | --- |
| `@voltojs/core` | The *decision*: risk ceiling, allow/deny/ask, rule matching, denial wording | `permission-policy.ts`, `command-match.ts`, `hooks.ts` |
| `@voltojs/tools-*` | *Declarations* a decision can use: `riskTier`, `requires`, `pathInputs` / `hostInputs` / `commandInputs` | `packages/tools/*/src` |
| `@voltojs/runtime-node` | The *enforcement*: OS sandbox wrappers, path resolution for rules, egress, credential fences, process spawns | `sandbox.ts`, `sandboxed-filesystem.ts`, `egress.ts`, `database.ts` |
| `@voltojs/sdk` | Assembly: one `SandboxConfig` per session, capability grants, rule collection | `create-agent.ts` |
| `apps/gateway` | Policy *sources* (config sections), the control plane, approval transport, audit | `wiring.ts`, `config/*.ts`, `auth/*`, `sessions.ts` |

Four strengths are distinguished throughout; conflating them is what this page prevents:

- **Enforced** — the effect is blocked whatever tool or argument the model picks.
- **Conditional** — enforced only when the host wired it or a helper binary exists
  (`socat`, a backend runner); the code says so where it degrades.
- **Advisory** — text or display metadata; no decision reads it.
- **Declared but unenforced** — a config field with no reader (listed under gaps).

## Threat model in one page (defended vs. not defended)

volto defends against **the model making a mistake**: a hallucinated `rm -rf`, an edit in
the wrong file, an exploratory action that turns irreversible. It does **not** promise to
defend against **a model that has been steered** — by a file it read, a web page, or tool
output. That is an architectural conclusion, not a missing feature, and it comes from one
fact: `bash` is free text, so per-tool-name grading is an **upper bound**, never a
guarantee.

What the "mistake" tier actually bounds, and with what:

| Mistake | Bounded by | Symbol |
| --- | --- | --- |
| Destructive or irreversible command | Risk tier + approval policy, and the sandbox for the file effect | `decide` (`permission-policy.ts`), `createSandboxedShell` |
| Writing outside the granted tree, or through a symlink | realpath-based containment, twice: in-process fs fence and the OS profile | `assertWritable` / `realResolve` (`sandboxed-filesystem.ts`), `buildSeatbeltProfile`, `buildBwrapArgs` |
| Running in the wrong directory | Only the writable range is enforced; `cwd` is a hint the session reports (`cwdAfter`), not a boundary | `persistent-session.ts` |
| An irreversible call "just happening" under a permissive preset | `IRREVERSIBLE` tools are pruned from the visible set above the ceiling, so the prompt never arises | `filterVisibleTools` + `riskCeiling` (`runner.ts`) |
| Reading a credential and pasting it into an answer | Config-dir read fence + env stripping | `deniedReadPaths`, `SECRET_ENV_PATTERNS` |
| Escaping via a dangling/relative/ancestor symlink | Component-wise `realResolve` (the 2026-09-09 escape, now regression-tested) | `sandboxed-filesystem.ts` |

What is **not** defended, with the reason each is out of scope:

- **A steered model.** `bash` can do anything a graded tool would be refused for. The
  proven path: write `.git/hooks/post-commit` inside the workspace, and the next commit
  runs it as the host user, outside the sandbox. Closing known paths does not remove the
  class. See *Decisions* for why no command classifier exists.
- **Host credentials.** `~/.ssh`, `~/.aws` and `~/.kube` stay readable, and
  `SSH_AUTH_SOCK` is deliberately kept so `git push` works (`SECRET_ENV_PATTERNS` does not
  match it). Under this threat model that is a fair trade; under another one it is not.
- **Anything a bash child does with the network.** So does the model's own transport. The
  `egress` policy is a tool-level allowlist; `curl` inside `bash` never passes through it.
- **Workspace files that execute later.** `workspace-write` makes the whole workspace
  writable with no overlay exceptions (`wiring.ts:410-435`): `package.json` scripts,
  `Makefile`, CI config, `node_modules/.bin`. That is what the tier grants.
- **Content the model writes that comes back later.** Memory entries (`.volto/memory`) are
  retrieved into later sessions, spill files are re-readable, transcripts are exported.
  Injected retrieval carries a fixed "reference, not instruction" header
  (`buildRAGMessage`, `retrieval.ts`) and records a `context_reminder(kind:"retrieval")`
  audit event (`runner.ts:1947`) — a speed bump, not a boundary.
- **Third-party code the host loads.** A language server is sandboxed, but it can read
  whatever it can read. The MCP package, if a host ever wires it, spawns servers with a
  bare `spawn()` and `{...process.env}` (`packages/tools/mcp/src/stdio-transport.ts:40`) —
  outside every decorator, i.e. host-trust code. Plugin tools run in-process. MCP is
  currently unconnected, like the `Secrets` port.
- **Resource exhaustion.** CPU, memory and process count are outside the mode vocabulary;
  `SandboxPolicy.memoryLimitBytes` is declared and never applied.

Bottom line: the boundary is sized for a helpful model that got something wrong; against a
steered model the host must provide isolation (`SAFETY.md`).

## How each boundary is implemented (sandbox, credentials, egress, permission rules)

### File effects: the only thing the sandbox governs

`SandboxMode` is one axis of `PermissionConfig`; `ceilingOf` maps it to a risk ceiling:
`read-only` → `READ_ONLY`, `workspace-write` → `WRITE_HIGH`, `danger-full-access` →
`IRREVERSIBLE`. The mode is handed to three enforcing surfaces, and nothing else:

| Surface | Decorator | What it wraps |
| --- | --- | --- |
| In-process fs tools | `createSandboxedFileSystem` | `read` / `readBytes` / `stat` / `write` / `list` / `glob` / `grep` / `resolvePath` |
| Commands | `createSandboxedShell`, `createSandboxSessionSpawner` | one-shot `exec`, background `launch`, the persistent `bash -s` session |
| Non-shell children | `createSandboxedProcessSpawner` | language servers (argv, no shell) |

`apps/gateway/src/wiring.ts` builds the triple once per session in
`buildSandboxConfigs(mode, cwd, deniedReadPaths)` — `fsConfig`, `shellConfig`,
`lspConfig` — and `createAgent` derives *both* the wrapped shell and the session spawner
from `shellConfig`, so the bash paths cannot disagree with the fs paths. That single-source
rule is load-bearing: the earlier wiring wrapped the shell in the host while the default
persistent-session path stayed bare, and the config claimed confinement the process did not
have.

Two facts keep "the sandbox ran" from being an assumption:

- `sandboxEnforcement: "full" | "partial" | "none"` is attached to the adapter object and
  reports what the selected backend achieves, not what was configured
  (`sandbox-enforcement.ts`, `SandboxedShell`). `"partial"` has no producer today.
- `classifyRunnerFailure` separates "the runner refused or crashed" (exit `126`, an
  `[sandbox] INFRASTRUCTURE FAILURE:` stderr line from `missingRunnerEvents`, nothing ran)
  from a denial (`RUNNER_FAILURE_RULES` per backend, denial dialects in
  `DENIAL_SIGNATURES` — used by tests only). Without this split, the `-p`/`-f` defect read
  as an ordinary command failure for three review rounds.

`danger-full-access` returns a pass-through copy (`enforcement: "none"`) and confines
nothing, by definition. A confining mode with no usable backend refuses at construction
(`failIfUnavailable` defaults to `true`); the explicit `false` opt-out runs unconfined for
the shell/session spawners, while `createSandboxedProcessSpawner` returns `undefined`
instead of handing back an unconfined child.

**SQLite is the one file-touching surface the sandbox does not govern**, because it is an
in-process handle of the gateway: the boundary lives in the opener
(`createSqliteDatabaseOpener`, `database.ts`) as three explicit rules — the path is
realpath-checked into the workspace (fail-closed `DatabasePathError`), read-only handles are
opened `{readonly, fileMustExist}` and pinned with `PRAGMA query_only = ON`, and `ATTACH` /
`DETACH` / `VACUUM INTO` / `load_extension` are refused keyword-level after literals and
comments are stripped, because `query_only` covers none of them. The comment states the
assumption it rests on: that set is SQLite's whole file-touching surface, so a future SQLite
feature is a documented revisit rather than a silent hole.

### Credentials and the environment

Two mechanisms, both in the runtime package:

1. **Read fence over the credential directory.** `deniedReadPaths` carries the realpath of
   `~/.volto` (config, `auth-secret`, `access-token`, sessions, attachments, memory). On
   seatbelt it emits `(deny file-read-data…)` **and** `(deny file-read-metadata…)` — the
   wildcard form `file-read*` was verified on-host to silently no-op. On bwrap it is a
   `--tmpfs` mask, with a `PARITY NOTE`: a process holding an open fd keeps reading, and
   the path still exists as an empty directory. On the fs side `assertReadable` runs before
   `read` / `readBytes` / `stat` / `list` / `glob` / `grep` / `resolvePath`. The
   justification is closed-loop privilege escalation: a sandboxed process that could read
   `auth-secret` could forge the gateway cookie.
2. **Environment stripping.** `stripEnvFrom` (shell) and `buildStrippedEnv` (spawned
   children) rebuild the environment from `process.env` minus `strippedEnvVars` and minus
   names matching `strippedEnvPatterns` (regex `lastIndex` reset per test).
   `SECRET_ENV_PATTERNS` (`wiring.ts:457`) covers `API_?KEY`, `*_KEY`, `TOKEN`, `SECRET`,
   `PASSWORD`, `PASSWD`, `CREDENTIAL`. This is the only defence against
   `echo $OPENAI_API_KEY`, and the file-side fence would be worthless without it.

The stripping is **not uniform across modes**: `createSandboxedShell` returns the
`danger-full-access` pass-through before the stripping branch, so one-shot `exec` keeps
provider credentials in that mode; the session spawner's bare branch still strips
(`makeBareSessionSpawner`). Neither weakens anything — `danger-full-access` is unconfined by
contract — but a host that assumes "env is always stripped" is wrong.

`createNodeSecrets` (`secrets.ts`) honours an `allowedRefs` scope and `SECRET_*` env vars,
but nothing wires it: the SDK default resolves every ref to `undefined`. Treat it as a
scaffold, not as a credential boundary.

### Network egress: two layers, no firewall

Three distinct things are often collapsed into "egress". The code keeps them apart:

- **`wrapNetworkWithEgress` (`egress.ts`) — the `Network` port allowlist.** Exact,
  case-insensitive hostname; `denyHosts` wins; a malformed URL denies; a refused request is
  a structured `403 {error:"egress_denied"}`, never a throw. `createAgent` wraps the port
  once, so it covers `web_fetch`, `web_search` and `http_query`; the browser host receives
  the same policy separately for top-level navigation (`wiring.ts:663-666`). The policy
  comes from `config.json`'s `egress` section
  (`config/egress.ts`, legacy `egress.json` still read via the store's migration fallback);
  a malformed document refuses the session build.
- **The sandbox-side proxy — host filtering for shell children, conditionally.** Only when
  `network.enabled === true` **and** `allowedHosts` is non-empty: `createSandboxProxy`
  listens on a unix socket (CONNECT only, exact or `*.example.com` suffix), `socat` bridges
  `127.0.0.1:<port>` to it, and the child gets `http_proxy` / `HTTP_PROXY` / `HTTPS_PROXY`.
  The lowercase `http_proxy` is required — curl ignores the uppercase form for plain
  `http://`. No `socat` means a warning and **no proxy variables**, i.e. the allowlist is
  silently unenforced — the same fail-open direction as the hooks-config load, and unlike
  every other policy failure.
  Plain-HTTP requests through the proxy get `405` and are therefore refused even for
  allowlisted hosts — over-blocking, not a bypass.
- **The model's own transport and anything a bash child opens directly.** Outside both
  layers. The gateway enables `network: { enabled: true }` for shell sessions
  (`buildSandboxConfigs`) precisely because the sandbox's network toggle is on/off, not a
  policy. `createSandboxedProcessSpawner` **throws** at construction when `allowedHosts` is
  non-empty, because it builds no proxy — a promise it cannot keep is refused, not ignored.

### Permission rules and approval (the interruption layer)

The decision path is pure and auditable:
`resolvePermission(config, toolName, riskTier, capabilities, resolved, commands)`
(`permission-policy.ts`) computes `decide(ceiling, approval, tier)` first, then applies the
first matching rule:

- **Rules can tighten freely, and below the ceiling may turn an `ask` into an `allow`.**
  Above the ceiling the result is `moreRestrictive(rule.decision, base)` — a config file can
  never write through a read-only session. This clamp is what makes the feature safe; an
  earlier "rule wins outright" return let configuration outrank the boundary.
- **Rule matching is two groups ANDed**: tool keys (`toolName`, `toolPattern`,
  `capability`) and parameter keys (`pathPattern`, `hostPattern`, `commandPrefix`). A rule
  with no key never matches, and the loaders reject one.
- **A parameter rule reaches only tools that declare the parameter.** `pathPattern` is
  resolved by `createToolInputFactResolver` with the *sandbox's own* `realResolve` (absolute
  + symlinks) against `pathInputs`; `hostPattern` against `hostInputs`. `bash` declares
  `commandInputs: ["command"]` and **no** `pathInputs`, so no path rule constrains it — the
  single most important truthful limitation in the feature. `web_search` declares no
  `hostInputs` (its URL is fixed), so only `web_fetch` and `http_query` are reachable by
  `hostPattern`.
- **`commandPrefix` is an interruption reducer, not a boundary.** `tokenizeCommand`
  (`command-match.ts`) accepts only a single simple command: a shell metacharacter (`;`,
  `&`, `|`, `<`, `>`, `$`, parentheses, braces, `*`, `?`, brackets, `~`, backslash, a
  backtick), a newline, a leading `NAME=value`, or a quote containing one of those
  disqualifies the command, which then prompts as usual. The config loader additionally
  requires a `toolName`/`toolPattern`, allows at most 8 matchable tokens, and permits
  `allow` only — a `deny`/`ask` prefix rule would fail open on everything it fails to match.
- **"Always allow" writes a rule, never a ceiling exception.** `POST /approvals` with
  `remember: {prefixTokens}` reaches `rememberRule` (`apps/gateway/src/sessions.ts:2207`),
  which derives `{toolName:"bash", commandPrefix, decision:"allow"}` from the command the
  *server* recorded and appends it via `savePermissionRule` under the config store's lock.
  Deduplication refuses identical or broader rules; a failed save still settles the approval
  as allowed and reports `rememberError`; the rule takes effect on the **next turn**
  (`effectiveFrom: "next_turn"`).
- **Rules and approvals cannot widen downward.** `narrowPermission` keeps parent `deny`
  rules, keeps child `deny`/`ask`, drops every `allow` (parent's and child's), and clamps
  `sandbox`/`approval` to the stricter of the two. Sub-agent Runners get
  `createSubAgentApprovalGate()`, where `ask` resolves to `deny` — a child has no human to
  fabricate consent from.
- **A refusal explains itself.** `policyDenialMessage` / `userDenialMessage` name the
  setting (or the human answer) and forbid reaching the *refused effect* through another
  tool, without forbidding ordinary tool switching. This wording is part of the mechanism:
  a bare "denied" invited the model to re-run a refused `git_push` through `bash`.

Approval transport is the control plane's job; see the next section.

### Command hooks: host-trust guardrails

Hooks are declared in `config.json`'s `hooks` section, compiled to core `Hook[]`
(`runHookPipeline`, `hooks.ts`) and executed by `runCommandHook`
(`apps/gateway/src/config/hooks.ts`). They are **not** a boundary, and `SAFETY.md` says so:

- They run in the **host process**, outside the sandbox, and inherit the host environment
  verbatim — no `*API_KEY*` stripping. A hook that needs a clean environment must clear it.
- **Exit codes are the whole protocol**: `0` continue (stdout drained and discarded, so it
  never enters model context); `2` deny with the trimmed first stderr line as the reason;
  any other code, spawn failure or the 10 s timeout (`DEFAULT_HOOK_TIMEOUT_MS`, SIGTERM
  first) is a **fail-closed deny**. stderr collection is capped at 64 KiB with dropped
  characters disclosed.
- **The configuration is the fail-open edge.** Unknown lifecycle keys or unknown entry
  fields throw `HooksConfigError`; `wiring.ts` catches it, warns, and builds the session
  **without config hooks**. Deliberate: refusing to *load* is not refusing a policy, and
  stopping the service buys no security. The cost is real — a broken `hooks.json` means a
  session with no interception, silently apart from the startup warning.
- **stdin carries model-controlled data.** `preToolUse` / `postToolUse` context includes
  tool input and tool results; a hook that executes stdin (`eval`, `| sh`) executes model
  output in the host trust domain and gives away the entire position.

### The gateway control plane

The gateway is the part of the system that holds credentials, defines project roots, and
adjudicates approvals, so it is treated as hostile-adjacent:

- **Loopback by default, refused otherwise.** `LOOPBACK_HOSTS` (`server.ts:330`) admits
  `127.0.0.1`, `localhost`, `::1`; anything else throws at startup. **Divergence from
  `SAFETY.md`:** there is one opt-in — `--serve-remote` (`serveRemote`, `mode: "remote"`) —
  which permits a non-loopback bind and withdraws the native dialog routes. `SAFETY.md`
  states the refusal unconditionally; the code documents the opt-in instead.
- **Every route except `/health` is authenticated.** `createAuthGuard` runs before route
  matching so an unauthenticated caller cannot enumerate routes; every failure is the same
  byte-identical `401` (a failed attempt feeds a per-IP rate limiter that can never lock out
  a valid credential). `auth-secret` and `access-token` live in the `0700` config dir as
  `0600` files; cookies are HMAC'd with `auth-secret` and invalidated by
  `volto token --rotate`.
- **Approvals are bound to the connection that displayed them.** `decideApproval`
  (`sessions.ts:2170`) requires the per-connection token minted in `attach()` whenever the
  session has a live connection, and checks it *before* looking at `callId`, so a guess
  learns nothing. A sandboxed `bash` that can reach the port but never saw the channel
  cannot settle an approval. Fail-closed on detach and interrupt; the gateway deliberately
  has no timeout (a pending approval is more visible than a self-resolving denial), while
  the desktop gate denies after 5 minutes.
- **The seatbelt loopback filter is not coming back.** A
  `(deny network* (remote ip "localhost:*"))` rule was tried and verified to degrade into
  "deny everything"; the control plane is protected at the route instead
  (`buildSeatbeltProfile`).

### Data the model writes: spill, memory, transcripts

- **`<workspace>/.volto/spill/` is not the credential directory** and must never be merged
  with it: spill files exist so an oversized tool result stays readable by `read_file`,
  whereas `~/.volto` exists so it cannot be read. Spilling happens in the host runner
  (`applySpill`, `spill-store.ts`), outside the sandbox child.
- **`~/.volto/memory/` is untrusted reference content**: one `<projectId>.jsonl` per
  project, injected text carrying a fixed reference-only header and a `retrieval` audit
  event. Poisoning it is outside the defensive promise, and it is single-process
  append-only with no cross-process lock.
- **Transcripts sit inside the fenced `~/.volto`** — unreadable to a gateway session, but
  they hold everything the model read and are protected only by directory permissions.

## Known gaps and failure directions (fail-open vs. fail-closed)

| Path | Direction | What it means |
| --- | --- | --- |
| Malformed `egress` / `permissions` / `lsp` config | fail-closed | the session build is refused; no silent "no policy" |
| Malformed `hooks` config | **fail-open** | warning, session builds without config hooks — interception silently absent |
| `socat` missing | **fail-open** | allowlisted shell egress is not filtered; a warning is all there is |
| No isolation backend under a confining mode | fail-closed | construction throws; `failIfUnavailable: false` opts out (shell/session unconfined, process spawner returns `undefined`) |
| Runner binary missing after construction | fail-closed | `exec` yields `INFRASTRUCTURE FAILURE` + exit 126; `launch` throws |
| Unknown permission preset in the gateway | fail-closed | `read-only` for the legacy shared agent (`server.ts:702`) and `EMPTY_CONFIG`; `normaliseUiPermissionMode` maps retired names, never to the widest tier |
| Approval disconnected / interrupted | fail-closed | `settleAll("deny", reason)` with `connection-lost` / `interrupted`, so the denial is recorded and shown rather than silent |
| Rule above the sandbox ceiling | clamped | `moreRestrictive(rule.decision, base)` |
| Child sub-agent policy | narrowed | `narrowPermission` drops every `allow` |
| Browser sub-resources / page-initiated requests | outside the filter | only top-level navigation is policy-checked (`browser-host.ts`) |
| `db_exec` under a read-only session | not registered | invisible to the model; `db:write` is only granted when `sandboxMode !== "read-only"` |

Declared-but-unenforced fields, worth knowing before trusting a config:

- `SandboxConfig.seccomp` — no reader; it does not enable anything.
- `SandboxPolicy.memoryLimitBytes` / `fsReadOnly` — no reader (`createNodeSandbox`, the
  `Sandbox` port adapter, is not used by any production caller anyway).
- `SandboxPolicy.egressAllow` on that adapter is an `EGRESS_HOST` env-var convention, not
  network filtering.
- `PolicyEngine` — the port is combined `mostRestrictive` and a throwing engine denies, but
  no shipped host sets one; `createAllowAllPolicyEngine`'s "safe default" comment is
  misleading (it allows everything).

### Where the code and `SAFETY.md` disagree

1. **Non-loopback bind.** `SAFETY.md` says bindings other than loopback are "refused at
   startup". They are refused unless `--serve-remote` is passed (`server.ts:645`). The code
   is the truth; the sentence describes the default posture.
2. **The credential-directory fence is a gateway-wired config.**
   `SAFETY.md` states `~/.volto` is denied on the shell, filesystem and LSP-child sides.
   That holds for gateway sessions, which pass `[configDirRealPath]` into
   `buildSandboxConfigs`. `apps/desktop-app/src/main/agent/wiring.ts:116-125` builds its
   `SandboxConfig` without `deniedReadPaths` (and without an `lspConfig`), so a sandboxed
   desktop command can read `~/.volto` — and the desktop's own credential store
   (`electron-store`, plaintext under the app's `userData`) is not fenced at all.
3. **Spill read-back when the workspace is the home directory.** `SAFETY.md` requires spill
   files to be readable back by `read_file`. The fence covers the *realpath* of the
   credential directory, so in the configuration where the workspace root **is** (or
   contains) `$HOME`, `<workspace>/.volto/spill/…` and `~/.volto/spill/…` are the same
   directory and `assertReadable` refuses the read. Over-blocking, not a leak — but the
   "full text is never lost" promise becomes "the file is on disk and the model cannot read
   it back".

## Decisions and rejected alternatives (with dates)

| Date | Decision | Rejected alternative |
| --- | --- | --- |
| 2026-09-09 | Threat model is "the model makes a mistake"; induced-model defence is delegated to a disposable VM | Building the boundary for a steered model while `bash` exists |
| 2026-09-09 | No command-content classifier, ever | A classifier: blocks the blatant case, misses the evasive one, and sells the illusion that it blocks them. Risk labels on approval cards stay display-only (`command-risk.ts` header; the only consumer is `ApprovalCard.tsx`) |
| 2026-09-09 | One sandbox knob drives the fs **and** shell/session decorators | A host wrapping the shell itself; that left the default persistent bash path unconfined |
| 2026-09-09/10 | `sandbox-exec -f FILE` (never `-p`), plus `sandboxEnforcement` reporting and runner-failure/denial separation | "Decorator present ⇒ sandbox effective", the posture that hid a dead sandbox for three rounds |
| 2026-09-10 | `~/.ssh` / `~/.aws` / `~/.kube` stay readable; `SSH_AUTH_SOCK` kept | Denying them, which breaks `git push` (inside what `workspace-write` grants) |
| 2026-09-10 | In-session `dynamicRules` deleted | A persistent grant that survives preset downgrades — the downgrade did not revoke it |
| 2026-09-20 | Reversal: a one-click "remember" writes a **visible, ceiling-clamped, cross-project** rule into the config file | Session-scoped implicit grants (deleted 2026-09-10); turn-scoped grants were the ruling only for that implicit kind |
| 2026-09-10 | Loopback carve-out in the seatbelt network rule reverted | Selectively denying the gateway port from inside the sandbox (degraded to deny-all); the route-level per-connection token replaced it |
| 2026-09-20 | Parameter rules match only tool-declared `pathInputs` / `hostInputs`, with facts resolved by the Runner | Hardcoding a tool→field table in core (unreachable for MCP); extracting paths from `bash` |
| 2026-09-20 | `commandPrefix` is strict-argv, allow-only, tool-scoped, ≤8 tokens | Segment analysis of `;` / `&&` / pipe chains, deny/ask prefix rules, `bash -c` introspection |
| 2026-10-12 | LSP children run under the same-tier sandbox **minus network**; sqlite is in-process and bounded by three explicit rules | Declaring LSP "outside the sandbox"; leaving sqlite's read-only to a regex over SQL verbs |
| 2026-10-17 | Command hooks: host-process execution, exit-code protocol, 10 s timeout, config-load fail-**open** | Embedding JS in the config; env-var configuration; failing the service on a bad `hooks.json` |
| 2026-11-13 (verified) | No `.git` / `.env` read-only overlays: writable range is the whole workspace | The overlay was added twice and removed twice — it protects one execute-later path while every other stays writable, and does not touch the `cat .env` read |

## How to change it (tests, what must not regress)

Static gates (affected packages only; never the whole repo, never `@voltojs/desktop-app`):

```bash
pnpm turbo run typecheck lint test --filter @voltojs/core
pnpm turbo run typecheck lint test --filter @voltojs/runtime-node --filter @voltojs/sdk
pnpm turbo run typecheck lint test --filter @voltojs/gateway
pnpm turbo run build --filter @voltojs/sdk   # tools/runtime/sdk consume dist, not source
```

| Area | Tests |
| --- | --- |
| Real backend behaviour (denials, env stripping, runner failure) | `packages/runtimes/node/src/__tests__/sandbox.test.ts` (`itDarwin` / `itBwrap`), `sandbox-enforcement.test.ts` |
| Spawners and sessions | `sandboxed-process.test.ts`, `sandbox-session.test.ts` |
| fs fence (dangling symlinks, denied reads) | `sandboxed-filesystem.test.ts`, `read-bytes-sandbox.test.ts` |
| SQLite containment and read-only | `sqlite-opener.test.ts` |
| Egress | `egress.test.ts`, `apps/gateway/src/__tests__/config-egress.test.ts` |
| Policy, rules, command tokens, narrowing | `permission-policy.test.ts`, `command-match.test.ts`, `command-risk.test.ts`, `narrow-permission.test.ts`, `permission-mode-replay.test.ts` |
| Gateway control plane and approvals | `attack-chains.test.ts`, `approval-gate.test.ts`, `auth-rate-limit-e2e.test.ts` |
| Config-sourced rules and hooks | `config-permissions.test.ts`, `remember-rule-e2e.test.ts`, `hooks-config.test.ts`, `hooks-config-session.test.ts` |

Assertions that must not regress (each encodes a real defect):

- **Assert the denial, not the silence.** Non-zero exit **plus** that backend's dialect
  (`Operation not permitted` on seatbelt, `Read-only file system` on bwrap). "Empty output"
  proves nothing: a missing runner, a typo and a crash all produce it.
- **Classify runner failure before denial**; a non-null `classifyRunnerFailure` means
  nothing executed.
- **Never union dialects across backends**, and never let a platform-specific suite pass
  silently on another platform — `itDarwin` / `itBwrap` / `itPosix` skips are not passes.
- **Read `sandboxEnforcement`, never `config.mode`,** for "is this confined".
- **A rule must never widen above the ceiling**, a sub-agent policy must never exceed its
  parent, and a client must not be able to submit a rule through `POST /approvals` (only a
  prefix length for a command the server recorded).
- **Risk labels must never become a decision input**; `command-risk.ts` stays consumed by
  display code only.
- **`bash` keeps declaring no `pathInputs`.** Adding one would turn a truthful limitation
  into a false guarantee.
- **Hook stdout stays out of model context**, and hook denial keeps normalizing to an
  `isError` tool result on the same path as a permission deny.
- **`policyDenialMessage` / `userDenialMessage` keep their scoping** — the refused *effect*,
  not tool switching.

When adding a surface: reuse `createSandboxedProcessSpawner` (argv, no shell) or
`createSandboxSessionSpawner` (stdin protocol) instead of a bare `spawn`; pass
`deniedReadPaths` through; update `buildSandboxConfigs` so fs, shell and LSP move together.
When adding a backend: extend `SandboxBackendName`, `RUNNER_FAILURE_RULES` and
`DENIAL_SIGNATURES`, and report `"partial"` if it cannot govern every promised effect.

## Further reading (archive links)

`SAFETY.md` is the authority on what none of this promises. Archive, frozen at the time of
writing (`docs/archive/…`; browse with its `INDEX.md`):

| Spec | What it explains |
| --- | --- |
| [security architecture analysis](../archive/superpowers/specs/2026-09-09-security-architecture-analysis.md) | The six structural root causes and the gateway attack surface as first surveyed; its per-route status table is superseded |
| [permission enforcement gaps](../archive/superpowers/specs/2026-09-09-permission-enforcement-gaps.md) | The wiring defects found after the permission redesign — the `-p`/`-f` defect, the symlink escape, the unconfined background path |
| [security roadmap decisions](../archive/superpowers/specs/2026-09-10-security-roadmap-decisions.md) | Why the threat model was fixed, why command classification is out, why host credentials stay readable |
| [parameter permission rules](../archive/superpowers/specs/2026-09-20-parameter-permission-rules-design.md) | Path/host rules, the declaration requirement, the ceiling clamp |
| [LSP / DB wiring](../archive/superpowers/specs/2026-10-12-lsp-db-wiring-design.md) | Putting LSP under the sandbox and giving sqlite an in-process boundary |
| [hooks host surface](../archive/superpowers/specs/2026-10-17-hooks-host-surface-design.md) | The hooks config surface, exit-code semantics and the deliberate fail-open load |

Related current pages: [runtime and sandbox](runtime-and-sandbox.md) (enforcement
mechanics in full), [tools and permissions](tools-and-permissions.md) (the decision and
approval machinery), [gateway and hosts](gateway-and-hosts.md) (routes, host divergence),
[architecture](architecture.md) (why decisions are pure).
