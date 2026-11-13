# Pure Agent Core — a general-purpose agent kernel

A zero-environment-coupling, zero-side-effect core with capabilities injected through
ports. A pure-function state machine (`step(state, input) → { state, effects[] }`) plus a
thin interpreter (Runner), pluggable tool packages and replaceable port adapters. Pure
TypeScript in a pnpm + Turborepo monorepo.

---

# 🔴 Rules you must read (every task)

> These rules are expensive to violate and easy to miss. **Confirm this section before
> starting any task, and re-check it before replying.**

## 0. Development-stage positioning — the standard for judging right from wrong

> volto is still under development: there are no external users and no compatibility
> burden.

- **The standard for judging a design is "does it make volto a complete agent", not
  "does it match the existing code".** Judge against what a mature agent such as Claude
  Code / Codex should be able to do.
- **Existing code is not an argument.** Every interface, contract, type, directory
  layout and port signature can be changed or overturned — they were decisions made at
  the time, not necessarily correct ones. If a design blocks the right solution, change
  it instead of working around it.
- **Do not make a design worse just to keep backward compatibility**, and do not copy a
  mistake because "that is how it is written today". There are no downstream callers to
  protect.
- **This is not a license for gratuitous refactoring.** Overturning must serve the
  current task; do not touch unrelated code.
- **Two exceptions are not up for debate**: the core purity invariant in §1 and the
  security position in `SAFETY.md`. They are the design goals themselves, not legacy.

## 1. Core purity invariant (Functional Core Purity) — the foundation of this project

> The core package `@voltojs/core` is a pure-function kernel. A single side effect
> invalidates replayability, snapshot testing and portability.

- **No I/O and no implicit side effects inside `packages/core/`**: no `Date.now()` /
  `Math.random()` / `crypto.randomUUID()` / `node:*` imports / direct `fs`. Time,
  randomness, IDs and token counts go through the `Clock` / `Random` / `Id` /
  `Tokenizer` ports.
- **The core only imports port interface types, never an implementation.** The
  `dependencies` and `peerDependencies` of `@voltojs/core` must stay empty (enforced by
  the `check-core-zero-deps` CI script).
- **All decision logic is pure** — the `step()` reducer, ContextAssembler, Compactor,
  ToolRouter and PermissionPolicy never touch I/O. Real side effects are expressed only
  as the returned `Effect[]` and executed by the Runner.
- **Replay discipline**: the same `AgentInput` sequence must produce exactly the same
  `(state, effects)` sequence twice. Run the replay tests as a regression gate after
  changing the reducer.

## 2. Definition of done (Execution Quality Gate)

> "Done" ≠ "types, interfaces, docs, skeleton or TODOs are in place".

A feature task must land on a real execution path, with all of the following:

1. **Decision–execution loop closed** — the pure core emits an `Effect` → the Runner calls
   the matching port → the result comes back to the core as an `AgentInput`.
2. **Tools wired** — tools pass ToolRouter validation and capability gating, so the model
   can select them; a tool whose port is missing drops out of the visible set
   automatically.
3. **Errors do not break the loop** — tool / model errors are normalized into a
   `ToolResult` with `isError: true` or a `ModelError` input and fed back; **never throw
   to abort the main loop**.
4. **Verifiable** — `pnpm turbo run typecheck lint test --filter <package>` passes for the
   affected packages (see the filter rules in §3), plus manual acceptance steps (or all
   Acceptance Criteria of the phase are green).

## 2.1 Sandbox and boundary-testing discipline (non-negotiable)

The sandbox once failed to take effect for **three full review rounds**
(`sandbox-exec` was given `-p` instead of `-f`) while the tests stayed green, because the
assertions never touched the real boundary.

- **Never prove a denial by asserting "empty output".** A sandbox that never ran, a
  misspelled command and a crashed runner all produce empty output. Assert the **denial
  itself**: a non-zero exit code **plus** the rejection signature of that backend's
  dialect.
- **Each platform asserts its own dialect**: Seatbelt → `Operation not permitted`,
  bwrap → `Read-only file system`. Do not union across backends — a union would claim a
  rejection that some backend never produces.
- **Check runner failure before denial.** The former means the command never ran
  (sandbox infrastructure failure); the latter means isolation works. See
  `packages/runtimes/node/src/sandbox-enforcement.ts`.
- **Platform-specific tests must be skipped explicitly** (`itDarwin` and the like); they
  must not pass falsely on other platforms.
- **`enforcement` is a runtime fact, not a configuration claim.** Every assertion that
  "there is a sandbox" must read `sandboxEnforcement`, never `config.mode`.

## 3. Hard constraints on code changes

- **Run static gates only for the affected packages**:
  `pnpm turbo run typecheck lint test --filter <affected-package>`. **Do not run the
  whole repo by default** — a full typecheck + test run is slow, memory-hungry (tens of
  minutes and several GB) and adds no information for a single-package change. Run the
  whole repo only for **cross-package contract changes (public types / port contracts in
  core)**, before a release, or when explicitly asked.
- **Always exclude `@voltojs/desktop-app`**: it depends on Electron binaries, is slow to
  build and adds no verification value. Filter it out of test / typecheck commands:
  ```bash
  # Affected package (recommended)
  pnpm turbo run typecheck lint test --filter @voltojs/sdk
  # Cross-package validation, excluding the desktop app
  pnpm turbo run typecheck lint test --filter '!@voltojs/desktop-app'
  ```
- **Rebuild `dist` for packages on the dependency chain**: `tools-*` / `runtimes-*` /
  `sdk` consume `dist`, not source. Cross-package tests on stale builds are falsely green
  or falsely red. Build the upstream package first
  (`pnpm turbo run build --filter <upstream>`), or include the upstream packages in
  `--filter` so turbo follows the dependency graph.
- **Dependencies point one way — downward**: `core ← tools-*/providers-*/runtimes-*/stores-*
  ← sdk ← apps`. **`zod` is allowed only in `tools/*` and `sdk`**; the core knows only
  the abstract `JSONSchema`.
  - **Type-import only (tools-*, providers-*, stores-*)**: these packages consume only the
    core's **interface types** (port contracts, `ToolDefinition` / `ModelEvent`, ...).
    Always use `import type`; never import a value from core, to avoid coupling to an
    implementation.
  - **Runner / SDK exception**: the thin interpreter (`runtimes-*` Runner) and the SDK
    facade are the kernel's **executors** and must value-import the pure kernel (`step` /
    `createInitialState`, ...). This is the point of functional-core / imperative-shell:
    importing pure functions does not break portability.
- **Directory and package naming** — category directories are **plural** (a collection):
  `tools/`, `providers/`, `runtimes/`, `stores/`. Package prefixes follow what the
  package **is**, singular or plural: `@voltojs/tools-fs` (one package, many tools,
  plural), `@voltojs/provider-openai` / `runtime-node` / `store-memory` (one instance
  each, singular).
- **Check the official documentation for third-party constructor parameters**; do not
  guess from memory (especially OpenAI-compatible streaming `tool_calls` chunk
  accumulation and Zod schema syntax).

---

# Workflow and quality gates

- **Capability gating vs. permission policy are separate responsibilities**: gating
  (ToolRouter) decides "is the tool visible to the model"; permission
  (PermissionPolicy) decides "is a visible tool allowed (allow / deny / ask)". Do not
  blur the two when changing either.
- Static gates: `pnpm turbo run typecheck lint test --filter <affected-package>` (**do not
  default to the whole repo; always exclude `@voltojs/desktop-app`**, see §3).
- **When a plan must end in a self-test report, use the `writing-selftest-reports` skill
  while writing the plan** — not when the report is due. It asks for a feature ledger at
  the top of the plan, evidence appended at the end of every task, and a final task that
  generates the report from a fresh context. Remembering it at the end leaves only git
  history to reconstruct from.

## User documentation (`docs/user/`) — sync when a user-visible surface changes

User docs and developer docs have different audiences: developer docs explain "why the
design is this way"; `docs/user/` explains only "how to use it". The writing rules live
in `docs/user/WRITING.md`.

- **When to sync**: does this change affect something a **user** can see / configure /
  perceive (UI copy, menus, config keys and defaults, error messages, permission
  semantics, tool visibility, install steps), or a **public surface an integrator**
  relies on (`@voltojs/sdk` exports, `createAgent` options, port contracts, event types,
  gateway routes)? If yes, update `docs/user/` in the **same commit**.
- **Do not hand-edit generated pages**: `using/reference/tools.md`,
  `using/reference/config.md`, `integrating/reference/gateway-api.md` and
  `integrating/reference/sdk-exports.md` are produced by `pnpm docs:gen`. Change the code
  or the matching notes JSON (`docs/user/reference/*-notes.json` /
  `config-sections.json`) and regenerate. Adding a tool / config field / route without
  updating its notes makes `docs:check` fail — this is intentional.
- **Run `pnpm docs:check` before finishing** (after `pnpm turbo run build`). When a
  surface changed and the baseline was not synced, it fails and names the pages to
  update. If the change is genuinely invisible to users, run `pnpm docs:ack "reason"`;
  the reason is recorded in the diff.
- **Do not copy spec / plan content into user docs**, and do not explain implementation
  details (reducer / port / Effect) in `using/`. Those belong in `integrating/`.
- Every new page must be linked from `docs/user/README.md`, or the orphan-page check
  fails.

---

<details>
<summary>📚 Reference (stack / layout / commands / index)</summary>

## Tech Stack

- **Language**: TypeScript (strict / `noUncheckedIndexedAccess`)
- **Monorepo**: pnpm workspace + Turborepo (build / test / lint / typecheck graph)
- **Core**: a zero-dependency functional core — `state` / `input` / `effect` types, the
  `step()` reducer, pure ContextAssembler / Compactor / ToolRouter / PermissionPolicy
  decisions, and all port interfaces
- **Tool schemas**: Zod (runtime validation + JSON Schema derivation; only `tools/*` and
  `sdk` depend on it)
- **Providers**: pi-ai (the host default, with a multi-provider catalog and capability
  declarations), OpenAI-compatible, Anthropic
- **Runtime adapters**: Node (FileSystem / Shell / Network / Tokenizer / ApprovalGate /
  Sandbox), browser, edge
- **Stores**: memory / file / jsonl / sqlite / postgres (one shared SessionStore contract
  test suite)
- **Tests**: Vitest (including replay tests, the shared SessionStore behavior suite and
  capability-gating tests)

## Project Structure (current)

```
volto/
├── packages/
│   ├── core/                 # @voltojs/core   pure kernel + port interfaces  ← zero deps
│   ├── sdk/                  # @voltojs/sdk    facade: run / stream / resume
│   ├── eval/                 # @voltojs/eval   evaluation
│   ├── tools/                # one package per tool group
│   │   ├── fs shell web plan agent ask browser code data document mcp schedule vcs
│   │   ├── common/           # @voltojs/tools-common  defineTool and shared helpers
│   │   └── skill/            # @voltojs/tool-skill (singular prefix, unlike the rest)
│   ├── providers/            # openai / anthropic / pi-ai   → @voltojs/provider-*
│   ├── runtimes/             # node / browser / edge        → @voltojs/runtime-*
│   ├── stores/               # memory / file / jsonl / sqlite / postgres → @voltojs/store-*
│   ├── embedders/            # openai                       → @voltojs/embedder-*
│   └── memories/             # inmemory                     → @voltojs/memory-*
├── apps/
│   ├── gateway/      # HTTP + SSE host: wiring and event subscriptions only, core untouched
│   ├── web/                  # Next.js chat frontend consuming the gateway's SSE protocol
│   └── desktop-app/          # Electron host: wiring only, with approval dialogs
├── docs/                     # architecture, user docs, dev notes and archive
│   ├── user/                 # user-facing documentation (the GitHub Pages source)
│   ├── archive/              # frozen historical documents
│   └── superpowers/          # per-feature specs and plans (historical)
└── scripts/                  # repository-wide checks and analysis
```

> The pnpm workspace glob uses mixed depth: `packages/*` (core/sdk/eval) +
> `packages/*/*` (tools/providers/runtimes/stores/embedders/memories) + `apps/*`.

## Commands

```bash
pnpm install                              # install dependencies
pnpm turbo run build                      # build all packages
pnpm turbo run typecheck                  # typecheck (tsc --noEmit)
pnpm turbo run lint                       # lint (includes core zero-deps / purity rules)
pnpm turbo run test                       # tests (vitest)
pnpm turbo run test --filter @voltojs/core   # test only the affected package
node scripts/check-core-zero-deps.mjs     # verify the core has zero runtime deps
```

## Coding Conventions (details)

- **Core purity** — see §1; ESLint applies `no-restricted-imports` to `packages/core/**`
  to ban `node:*` and every `@voltojs/*` implementation package, and bans `Date.now` /
  `Math.random` / `crypto.randomUUID`.
- **Two-level ToolResult** — `modelContent` (for the model; terse, truncated with a
  declaration when oversized) + `displayMetadata` (for the UI / logs; diffs, line counts,
  durations, streamed through the EventSink).
- **`edit_file` edit format** — primary format is `str_replace` (`old_string` /
  `new_string` / `replace_all?`); on exact-match failure, fuzzy fallbacks (① ignore
  leading/trailing whitespace, ② ignore whitespace between tokens). A file that was not
  `read_file`'d or whose version is stale is refused; the version is compared again
  before writing. `apply_patch` (diff) remains an extension point, not implemented yet.
- **Cache-friendly** — ContextAssembler puts static content (system prompt / tool defs /
  project instructions) first and variable content (user input / tool results) last; tool
  set changes should happen at turn boundaries.
- **Determinism** — time / randomness / IDs are injected through ports, enabling offline
  replay and snapshot tests.

## Documentation Index

**The code is the only source of truth for "what a capability does now".** The documents
below explain **why** it is that way; they do not guarantee the current behavior.

| Document | Path | Purpose | Freshness |
| --- | --- | --- | --- |
| **User docs** | `docs/user/` | Manuals for users and integrators; sync whenever a user-visible surface changes (see the User documentation section) | Tracks the code |
| Architecture | `docs/pure-agent-core.md` | Pure-kernel architecture, module decomposition, port contracts — the source of the purity invariant | Long-lived |
| **Security position** | `SAFETY.md` | Threat model: prevents "the model makes a mistake", **does not promise** to prevent "the model is induced"; actual boundary strength and known gaps | Long-lived |
| Feature designs (spec) | `docs/superpowers/specs/` | Design trade-offs per feature; file names carry a date | A record of the decision at the time |
| Implementation plans | `docs/superpowers/plans/` | Per-task plans and acceptance criteria for the matching spec | A record of execution at the time |
| Roadmap | `docs/archive/roadmaps/roadmap.md` | Direction and invariants for platformizing the kernel | Historical; milestone table no longer tracked |
| **Archive** | `docs/archive/` | Frozen historical documents, not maintained | Do not treat as current |

**How to trace a feature**: read `docs/superpowers/specs/` in reverse date order (specs
are much shorter than plans), find the topic, then read the matching plan. Do not treat
any spec/plan as the current behavior — it records the decision **at the time**, which a
later spec may have overturned.

</details>