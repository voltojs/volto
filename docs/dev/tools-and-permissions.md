---
title: Tools and permissions
status: current
source:
  - packages/core/src
  - packages/tools
  - packages/runtimes/node/src
  - packages/sdk/src
  - apps/gateway/src
  - apps/desktop-app/src
verified: 2026-11-13
supersedes:
  - docs/archive/superpowers/specs/2026-09-09-permission-redesign-design.md
  - docs/archive/superpowers/specs/2026-09-09-permission-enforcement-gaps.md
  - docs/archive/superpowers/specs/2026-09-20-parameter-permission-rules-design.md
  - docs/archive/superpowers/specs/2026-09-20-shell-command-prefix-rules-design.md
  - docs/archive/superpowers/specs/2026-09-20-approval-remember-rule-design.md
  - docs/archive/superpowers/specs/2026-10-15-toolset-governance-design.md
  - docs/archive/superpowers/specs/2026-10-30-skill-catalog-design.md
  - docs/archive/superpowers/specs/2026-11-09-three-protocol-routing-design.md
---

# Tools and permissions

## Scope and where it sits

How a tool goes from a declaration in `packages/tools/*` to a model request, to an
executed call, and to an allow / deny / ask answer. Four layers split the work:

| Layer | Owns | Never does |
| --- | --- | --- |
| `@voltojs/core` | `ToolRouter` (visibility, validation), `PermissionPolicy` (decision), the reducer's approval states | Any I/O, path resolution, URL parsing |
| `@voltojs/tools-*` | Tool declarations: name, schema, `requires`, `riskTier`, `pathInputs` / `hostInputs` / `commandInputs` | Decide whether they may run |
| `@voltojs/runtime-node` | Executes the decision: parameter-fact resolution, gate calls, audit, tool execution, error normalization | Choose policy |
| `@voltojs/sdk` + hosts | Capability set from wired ports, preset table, rule file, approval gate, per-turn `riskCeiling` | Re-implement the matrix |

Two distinctions the rest of the page depends on:

- **Gating vs. permission.** Gating (`filterVisibleTools`, `routeToolCall`) decides whether
  a tool is visible and callable; permission (`resolvePermission`) decides `allow` / `deny` /
  `ask` for a visible tool. They are independent; do not smuggle a change of one into the
  other.
- **Advisory vs. enforced.** A permission decision is a core verdict always enforced by the
  Runner. The OS sandbox (`packages/runtimes/node/src/sandbox.ts`,
  `sandboxed-filesystem.ts`) is the actual filesystem boundary — see
  `docs/dev/runtime-and-sandbox.md`. Risk labels on approval cards (`classifyCommandRisk`,
  `packages/core/src/command-risk.ts`) are display text only and must never be consulted by
  a decision; the file says so in its header.

## Current behavior (registration, router, capability gating, policy decision, approval)

### Registration

A tool is a `ToolDefinition` plus a handler. `defineTool`
(`packages/tools/common/src/define-tool.ts`) builds it from a Zod schema: converted with
`z.toJSONSchema` for the model, re-validated with `safeParse` inside the handler, so invalid
input becomes an `isError` `ToolResult` rather than a thrown error. The definition type is
`packages/core/src/tool.ts`.

`createAgent` (`packages/sdk/src/create-agent.ts`) is the only place that knows the full
tool list. It collects tools from wired ports (`fs` → 8, `shell` → 3 shell + 6 `vcs`,
`network` → 3, plus `lsp`, `db`, `browserAdapter`, `memoryStore`, `fileWatcher`,
`scheduler`, `skillRegistry`, `planStore`, MCP `ToolSource`s, plugin/custom tools), then
applies visibility governance:

1. `buildDefaultToolVisibility` (`packages/sdk/src/tool-scope-default.ts`) synthesizes a
   scope — `fs` / `shell` / `git` 100, `basic` 50, `browser` / `memory` 45, `lsp` / `db` 40,
   `info` 20, `rest` 0 — and a limit of `20 + 10 if browser + 5 if lsp + 1 if memory`. Every
   actual tool maps to exactly one present group, so an unknown or plugin tool lands in
   `rest` and merely competes for a slot.
2. `filterByScope` (`packages/core/src/tool-router.ts`) keeps enabled groups, sorts by
   priority (stable), and truncates. An explicit `toolVisibility` host option replaces the
   built-in table wholesale instead of merging.
3. The result is `stepContext.tools`, which `ContextAssembler` and `buildCallModelEffect`
   (`packages/core/src/reducer.ts`) send as `request.tools`.

### Capability gating

`filterVisibleTools(tools, availableCapabilities, ceiling)` keeps a tool only when every
entry of its `requires` is granted **and** its `riskTier` is at or below `ceiling`. The
Runner computes this once per Runner instance (`runner.ts:912`). Hosts derive that ceiling
with `visibleRiskCeiling(permissionConfig)`: normally it is `ceilingOf(sandbox)`, but
`workspace-write` + `ask` raises it to `IRREVERSIBLE`, because `decide` escalates an
above-ceiling call to a human and a prompt needs the tool to stay visible. `read-only` /
`plan` and `auto` (`never`) still prune, so the model never sees a tool it would only be
refused for using.

The capability set is derived, not configured (`create-agent.ts:1620-1695`):

| Capability | Granted when | Tools unlocked |
| --- | --- | --- |
| `filesystem:read` / `:write` | `opts.fs` | `read_file`, `ls`, `glob`, `grep` / write family |
| `filesystem:watch` | `opts.fileWatcher` | `watch_files`, `unwatch_files`, `list_watches` |
| `shell:exec` | `opts.shell` | `bash`, `bash_output`, `kill_shell`, `git_*`, `run_tests`, `build` |
| `network:fetch` | `opts.network` | `web_fetch`, `web_search`, `http_query` |
| `db:read` / `db:write` | `opts.db` / `opts.db.allowWrite === true` | `db_query` / `db_exec` |
| `lsp:query`, `browser:control`, `scheduler:exec` | corresponding adapter | `lsp_*`, `browser_*`, `schedule_*` |
| `document:parse` | always (the tool always ships) | `read_document` |
| `memory:read` + `memory:write` | `memoryStore` and `memory.tools !== false` | `memory` |
| `plan:write` | always | `todo_write` |
| `skill:load` | `opts.skillRegistry` | `skill` |
| `agent:task` | `enableTaskTool` | `task`, `task_output` |
| `agent:can-delegate` | `maxAgentDepth > 0` (default 2) | the same two tools |
| `model:vision` | `modelVision === true` only | pure image producers |
| `mcp:<serverId>` | MCP connection up | that server's tools |

`CAP_AGENT_DEPTH_AVAILABLE` deliberately doubles as the depth limit: an agent at its
depth cap never sees a tool it would be refused for using (`tool-router.ts:5-11`).
`model:vision` is tri-state — absent means unknown, so a gateway that cannot describe its
model does not lose image tools; `read_file` / `read_document` gate at call time instead.

### The router at call time

`routeToolCall(visibleTools, capabilities, call)` (`packages/core/src/tool-router.ts`) runs
inside `executeTool` before hooks and before the executor (`runner.ts:2398`). It returns
one of:

- `Unknown tool: <name>` — the name is not in the visible set. A tool pruned by the risk
  ceiling reaches this branch, so the model sees "unknown tool", not "above your ceiling";
  the boundary reminder (`buildPermissionReminder`, see below) is what tells it the tools
  were removed. Under the `ask` preset, an `IRREVERSIBLE` tool above the sandbox ceiling
  stays visible and its call is escalated to a human instead of reaching this branch.
- `Tool "<name>" is not available: missing capability <cap>.`
- `Invalid input for tool "<name>": …` from `validateToolInput`, which checks the object
  shape, `required`, `enum`, and top-level property types only. Element types inside
  arrays, nested object properties and `oneOf` / `anyOf` / `allOf` are not enforced there —
  the tool's Zod handler is the real validator, and its failure is also an `isError`
  result.

Executor failures are normalized to `isError` results (`runner.ts:2460-2467`), never
thrown. `preToolUse` / `postToolUse` hooks run around the executor; a hook `deny` becomes the
same kind of tool error the permission layer produces, so the reducer never observes "hook"
(`packages/core/src/hooks.ts`).

### The policy decision

`PermissionConfig` is exactly two orthogonal knobs plus rules
(`packages/core/src/permission-policy.ts`):

- `sandbox`: `read-only` | `workspace-write` | `danger-full-access` — the ceiling, via
  `ceilingOf` → `READ_ONLY` | `WRITE_HIGH` | `IRREVERSIBLE`.
- `approval`: `ask` | `never` — the interruption policy inside the ceiling.
- `rules?`: `PermissionRule[]`, evaluated first-match-wins, outranking the matrix.

`decide(ceiling, approval, tier)` is the matrix: above the ceiling an `ask` policy
escalates to `ask` and `never` denies; at or below it `never` allows, and `ask` stops only
for `WRITE_HIGH` / `IRREVERSIBLE` (`READ_ONLY` and `WRITE_LOW` pass without a prompt).

`resolvePermission(config, toolName, riskTier, capabilities, resolved, commands)` computes
the matrix baseline, then applies the first matching rule. Rule matching has two key
groups: tool keys (`toolName`, `toolPattern`, `capability`, OR within the group) and
parameter keys (`pathPattern`, `hostPattern`, `commandPrefix`, OR within the group); a rule
with both must satisfy both. A rule with no key never matches (config loaders reject it; it
stays inert here so a hand-built config cannot become a blanket deny).

Rules may tighten freely. They may also turn an `ask` into an `allow` **below** the
ceiling. Above the ceiling the decision is `moreRestrictive(rule.decision, base)`, so a
config file can never write through a `read-only` session.

The Runner supplies the facts core must not compute (`runner.ts:2522-2634`):

- `createToolInputFactResolver(pathRoot)` (`packages/runtimes/node/src/tool-input-facts.ts`)
  resolves every declared `pathInputs` value with the sandbox's own `realResolve` (absolute
  + symlinks) and returns both the absolute and workspace-relative form, and reduces every
  `hostInputs` URL to a lowercased hostname. It is constructed only when
  `hasParameterRules(config)`; values starting with `~` are skipped rather than guessed.
- `collectCommandValues(toolDef.commandInputs, input)` collects raw command strings when
  `hasCommandRules(config)`; tokenizing and matching stay in core
  (`packages/core/src/command-match.ts`).

An external `PolicyEngine` (`RunnerOptions.policyEngine`, port in
`packages/core/src/ports.ts`) is evaluated alongside and combined with
`mostRestrictive`; a throwing engine becomes `deny` (fail-closed). The gateway wires a
rule-based engine or the allow-all default (`policy-engine.ts`).

### Approval

The decision path for one batch (`runner.ts:2522` onward):

1. Every pending call is classified. `deny` immediately feeds an `isError` tool result
   whose text is `policyDenialMessage` — it names the sandbox/approval setting in force and
   forbids reaching the same effect through `bash`. `allow` joins `parallelBatch`. `ask`
   joins `approvalQueue`.
2. For each queued call the Runner feeds `{type:"request_approval"}`. The reducer moves the
   tool off `pendingTools`, sets `pendingApprovalTool`, `status: waiting_for_approval`, and
   emits `request_approval` plus a `checkpoint` effect (`reducer.ts:1330`).
3. `interpretEffects` persists the checkpoint **first**, then calls
   `approvalGate.ask(toolCall, riskTier)` (`runner.ts:2941`). A gate may answer `"allow"`,
   `"deny"`, or an `ApprovalResult` carrying `reason` (and, for `ask_user`, `answer`).
4. The answer is fed back as `{type:"approval_decision"}`. Allow puts the tool back on the
   roster and into `approvedToolCallIds`, so the next classification pass sends it to the
   parallel batch without re-asking. Deny buffers an `isError` result from
   `denialMessageFor(name, reason)`: a user denial (`userDenialMessage`) reads differently
   from `connection-lost` / `interrupted`, which also say nobody is there to answer.
5. The batch flushes once every roster entry has a result — a denied tool stays on the
   roster so a mixed batch can still flush. Asks are sequential, allows are parallel.

A HITL pause is not a turn end: `recordTurnEnd` skips the `turn_end` bracket while the
state is `waiting_for_approval`, and `resume(sessionId, decision)` reloads the checkpoint,
pre-registers the decision in the same allow/deny sets, and continues the loop
(`runner.ts:3205`). Every termination path pairs each un-fulfilled `tool_use` with an
`isError` result (`synthesizeInterruptedResults`, `interruptionMessageFor`), because
providers reject an assistant message with unpaired `tool_use` blocks.

`ask_user` is the one tool that calls a gate directly (`packages/tools/ask/src/index.ts`),
bypassing the Runner and therefore the `approval_asked` transcript event. It gets a unique
call id from the `Id` port, and the gateway's registry hooks synthesize the
`approval_asked` / `approval_decision` brackets so the web card works
(`apps/gateway/src/sessions.ts:1184`). The SDK's `askUserGate` therefore defaults to
auto-allow and must only be pointed at a gate whose UI can display the question
(`create-agent.ts:921-941`); the gateway and desktop both pass their real gate.

### How approval reaches the host

| Host | Gate | Transport | Denial reasons |
| --- | --- | --- | --- |
| Gateway | `createApprovalRegistry` (`apps/gateway/src/approval-gate.ts`) — parks each `ask` on a promise | `approval_asked` / `approval_decision` transcript events stream over the session SSE channel; `POST /approvals` settles | `user`, `connection-lost` (detach), `interrupted` (interrupt) |
| Desktop | `createApprovalGate` (`apps/desktop-app/src/main/agent/approval-gate.ts`) — IPC to `ApprovalDialog` | main → renderer `agent:approval-request`, renderer → main decision | none; a bare `allow`/`deny`, 5-minute timeout resolves `deny` |
| CLI / tests | `createAutoAllowGate` / `createInteractiveGate` / `createSubAgentApprovalGate` (`packages/runtimes/node/src/approval-gate.ts`) | in-process | none |

Gateway specifics: `POST /approvals` requires the per-connection token minted in `attach()`
(`sessions.ts:1237`) whenever the session has a live connection, so a sandboxed process that
can reach the gateway port but never saw that channel cannot settle an approval by guessing
a `callId`. Bodies are validated before the token check (unknown keys rejected, `remember`
only with `allow`); responses are 400 for malformed bodies, 403 for a bad token, 409 for an
unknown `callId`, 202 with a receipt otherwise, and a malformed body never settles
anything. Unsettled approvals are denied fail-closed when the connection is replaced or
closed and on `interrupt()`; there is deliberately no timeout — a pending approval is more
visible than one that resolved itself.

### Audit and the model-facing reminder

`AuditSink.record` (`runner.ts:550-573`) receives `approval` (every gate decision),
`high_risk_exec` (a `WRITE_HIGH` / `IRREVERSIBLE` tool that ran), and `rule_allow` (a
`commandPrefix` rule turned an `ask` into an `allow`, with rule summary and command text).
`createFileAuditSink` appends JSONL.

Independently, `buildPermissionReminder` (`packages/core/src/permission-prompt.ts`) renders
the boundary in force from the same `decide` / `ceilingOf` functions the Runner uses, so
the wording cannot drift from behavior. The reducer injects it as an ordinary `user`-role
message at the **tail** of the history whenever `permissionFingerprint` changes
(`reducer.ts:692-718`), plus a `context_reminder` event. Tail placement is deliberate:
the assembled static prefix is the prompt-cache prefix, so describing a mid-session change
up front would invalidate it. Sub-agents get an `audience: "child"` variant that says no
human is available and that tells them to report the refusal instead of "tell the user".

## The tool contract and ToolResult shape

```ts
interface ToolDefinition {
  name: string;                       // snake_case, unique across all sources
  description: string;                // shown to the model
  inputSchema: JSONSchema;            // abstract subset: type/properties/required/items/enum/oneOf/…
  requires: Capability[];             // gating, namespace:action
  riskTier: RiskTier;                 // READ_ONLY | WRITE_LOW | WRITE_HIGH | IRREVERSIBLE
  writesSessionState?: boolean;       // true when it mutates volto's own session state
  trust?: "trusted" | "untrusted";    // untrusted output gets an isolation prefix
  pathInputs?: string[];              // fields the Runner resolves for pathPattern rules
  hostInputs?: string[];              // fields reduced to a hostname for hostPattern rules
  commandInputs?: string[];           // fields collected as raw command text for commandPrefix
}
```

A tool that only mutates volto's own session state — todos, task records, remembered
facts, scheduled wakes — is graded `READ_ONLY` and sets `writesSessionState: true`. The
grade is what keeps it visible under `read-only` / `plan`; the flag is descriptive (for
hosts, audits and UI) and does not relax the sandbox by itself.

Declaring a parameter input is the *only* way a parameter rule can reach a tool. Three
consequences are load-bearing rather than incidental:

- `bash` declares `commandInputs: ["command"]` and **no** `pathInputs`, so path rules never
  constrain the shell (`tool-input-facts.ts` resolves nothing for it).
- `git_*`, `run_tests` and `build` execute shell commands but declare no `commandInputs`,
  so `commandPrefix` rules cannot match them either.
- A tool that declares nothing simply never matches that rule kind; it is not an error.

`ToolResult` (`packages/core/src/tool.ts`) is two-layered:

- `modelContent: string | ToolResultBlock[]` — what the model sees. A string is shorthand
  for one block; the reducer normalizes it (`normalizeToolResultContent`). Tools truncate
  oversize output themselves and say so; the Runner additionally spills results above
  16 000 code points to `.volto/spill/` and leaves a reference (`applySpill`).
- `isError?: boolean` — a self-correctable failure. Errors are the normal channel; the loop
  is never aborted for a tool error.
- `displayMetadata?: Record<string, unknown>` — UI and logs only: diffs, line counts,
  `durationMs` (stamped by the Runner unless the tool measured itself), `sessionId` for
  `task` results, `timedOut`.
- `statePatch?: { todos?: TodoItem[] }` — the only state a tool may write back; unknown
  keys are ignored.

`trust: "untrusted"` (web, browser, memory, and any MCP-derived result) is enforced by the
Runner: a non-error result gets `annotateUntrustedContent`
(`packages/core/src/guardrails.ts`) — a prefix declaring the content reference-only.

Grading is per tool name, fixed at declaration — never derived from arguments, command text
or path. That is what makes `riskTier` an upper bound, not a guarantee: one `bash` call can
do what a graded tool would be refused for. `SAFETY.md` states the same limit as the reason
command-content classification is not a permission input.

## Permission modes, rules and their known limits

### Presets

`permission-presets.ts` (core) is the single preset table; the gateway re-exports it
(`permission-modes.ts`), and the web keeps its own literal copy of the same five names.

| Preset | `sandbox` | `approval` | READ_ONLY | WRITE_LOW | WRITE_HIGH | IRREVERSIBLE |
| --- | --- | --- | --- | --- | --- | --- |
| `read-only` | read-only | never | allow | deny | deny | deny |
| `plan` | read-only | never | allow | deny | deny | deny |
| `ask` | workspace-write | ask | allow | allow | ask | ask |
| `auto` | workspace-write | never | allow | allow | allow | deny |
| `full` | danger-full-access | never | allow | allow | allow | allow |

The matrix is the core verdict. In the visible set, `read-only` / `plan` and `auto` prune
tools ranked **above the ceiling before classification** (`visibleRiskCeiling` returns
`ceilingOf` there), so every write column is unreachable for the read-only presets and
`IRREVERSIBLE` is unreachable for `auto`. `ask` is the exception: `workspace-write` + `ask`
keeps `IRREVERSIBLE` visible, so `git_push` is offered and reaches a human for approval
instead of being pruned; under `full` it is allowed without a prompt. A Runner built
without `riskCeiling` (custom hosts, core unit tests) still reaches `decide`'s above-ceiling
branch for every tier; the clamp in `resolvePermission` keeps that safe for any caller.

`plan` and `read-only` share a config on purpose: a plan session differs by what it is
doing (plan artifact plus `save_plan`), not by its boundary, and `presetOf` therefore
returns the first match, `read-only`.

### Rules

Rules come from one place in the gateway: the `permissions.rules` array of the user-level
`config.json` (the archived spec called the file `permissions.json`; the code reads and
writes a section of `config.json` — `apps/gateway/src/config/permissions.ts`). They are
validated strictly and fail closed:

- top level allows only `rules`; unknown keys are a build error;
- at most 100 rules; each needs `decision` plus at least one match key;
- string keys must be non-empty; `pathPattern` gets `~` expanded so a rule cannot silently
  never match;
- `commandPrefix` is array-valued, at most 8 tokens, each passing
  `isMatchableCommandToken` (no whitespace, quotes, or shell metacharacters), requires a
  `toolName` / `toolPattern`, and is **allow-only** — a `deny`/`ask` prefix rule fails open
  on everything it does not match, which is the illusion the feature must not create.

`loadPermissionRules` runs once per session build (`wiring.ts:677`) and
`mergePermissionRules` puts user rules **before** any config-supplied rules, because
first-match-wins makes that ordering user intent.

Matching facts are deliberately narrow: `pathPattern` matches the canonical absolute path
or the workspace-relative form (`*` stops at `/`, `**` crosses it, everything else is
literal); `hostPattern` matches the lowercased hostname of a declared URL input;
`commandPrefix` compares argv tokens of a single simple command, and any shell
metacharacter, quote-escaped expansion, leading `NAME=value`, or newline disqualifies the
command (fail-closed: it is asked about as usual). `matchesCommandPrefix` compares token by
token, so `pnpm test2` does not match `["pnpm","test"]` while `pnpm test --filter x` does.

The one-click "remember" path writes into that same array: `POST /approvals` accepts
`remember: {prefixTokens}`, the server derives `{toolName:"bash", commandPrefix, decision:
"allow"}` from the command **it** recorded for that pending call (a client can never send a
rule object), dedups against identical or broader existing rules, and sets
`permissionsDirty`, which forces one rebuild at the next turn (`sessions.ts:2170`,
`rememberRule`). A failed save still settles the approval as allowed and returns
`rememberError`; it never pretends to have remembered anything.

### Known limits

1. **Parameter rules only reach declaring tools.** Path rules cannot see inside `bash`, and
   `hostPattern` is an approval filter, not a network boundary — the actual egress limit is
   `egress.json` on the Network port (`packages/runtimes/node/src/egress.ts`), which also
   cannot see `curl` inside `bash`.
2. **`commandPrefix` is a text-layer interruption reducer.** The persistent bash session
   keeps aliases, functions and `PATH` across calls, and the rule says nothing about `cwd`;
   the same command text can run something else. The spec's R1/R2 residual risks still hold.
3. **Session-state tools are graded `READ_ONLY`.** `task` / `task_output`, `todo_write`,
   `memory`, `schedule_task` / `cancel_task` never touch the workspace, so they declare
   `riskTier: "READ_ONLY"` plus `writesSessionState: true` and stay visible under
   `read-only` / `plan`. Their capabilities still gate them: `task` / `task_output` need
   `enableTaskTool`, `memory` needs a `memoryStore`, `schedule_*` need a `scheduler`, and
   `todo_write` needs only `plan:write`.
4. **MCP tools default to `WRITE_HIGH`** (`packages/tools/mcp/src/connection.ts`). The
   protocol says nothing about what a tool does, so the default grade makes `ask` stop on
   an MCP call, `read-only` / `plan` prune it, and `auto` / `full` allow it without a
   prompt. A host that trusts a server can grade all of its tools lower with
   `McpServerConfig.riskTier`. Gating is still only `mcp:<serverId>`.
5. **Some `READ_ONLY` tools build shell text from their input.** `run_tests` / `build` take
   a free-form `command`, so none declares `commandInputs`, `commandPrefix` cannot match
   them, and being `READ_ONLY` they are never asked about — the tier names the workflow,
   not the argument's power. `git_diff` is the exception: `args` is split into tokens and
   allowlisted (a fixed flag set, `--unified=<n>`, and revision/range tokens); any other
   token is a self-correctable error. The built command also passes `--no-ext-diff` /
   `--no-textconv`, so repo config or `.gitattributes` cannot attach an external command
   to a read.
6. **Session-scoped grants do not exist.** No `allow_always`; every `ask` is one call, one
   answer. Remembered rules are user-level, durable, visible, cross-project, and take effect
   next turn (the receipt says `effectiveFrom: "next_turn"`).
7. **The deny wording is part of the mechanism.** `policyDenialMessage` /
   `userDenialMessage` exist because a bare refusal invited the model to re-run the refused
   effect through `bash`; keep that scoping (the refused *effect*, not switching tools).
8. **Host divergence.** Desktop keeps its own three-value vocabulary but maps its `auto`
   tier to `workspace-write` + `never`, the same pair as the gateway's `auto`, and it
   denies after 5 minutes where the gateway deliberately never times out. Name the host.
9. **`permissionFingerprint` covers only `toolName` / `toolPattern` / `capability` /
   `decision`** while rules have six match keys. No reminder sentence depends on rules, so
   the omission is inert — but the comment claims full coverage and the code disagrees.

## Invariants and boundaries

- **The core stays pure.** `tool-router.ts`, `permission-policy.ts`, `command-match.ts`,
  `permission-prompt.ts`, `permission-presets.ts` and the reducer do no I/O; path resolution,
  URL parsing and gate calls live in the Runner. A change that wants `realpath` inside a
  decision is in the wrong package.
- **The ceiling is not negotiable by configuration.** Rules can only tighten above it; no
  rule, preset, remembered entry or client request may widen it. `narrowPermission` enforces
  the same rule downward for sub-agents: it keeps parent `deny` rules, keeps child
  `deny`/`ask`, and drops every `allow` (parent's and child's) so a narrowed child cannot
  inherit an exemption.
- **Narrowing only, never widening.** A sub-agent policy is `narrowPermission(parent,
  requested)`; a dispatch preset wider than the parent is rejected before any task is
  registered (`assertDispatchPermission`, `isWiderThan` compares sandbox ranks, not names).
- **A child has no human.** Sub-agent Runners get `createSubAgentApprovalGate()`, where
  `ask` resolves to `deny`; `permissionAudience: "child"` tells the model so. Passing the
  parent's gate into a child would silently fabricate human consent.
- **Invisible means never classified.** Gating runs first; permission only ever sees tools
  in the visible set. A call for a pruned name is an "Unknown tool" error.
- **Nothing throws out of the loop.** Tool errors, hook denials, policy denials, gate
  failures and executor rejections all become `isError` results; a denied or interrupted
  call is always paired with one.
- **Decisions are auditable.** `rule_allow` (a rule suppressed a prompt), `approval` (a
  gate answer) and `high_risk_exec` each leave a record.
- **Approval traffic never enters model context.** `approval_asked` / `approval_decision`
  are transcript/SSE events; the model learns the outcome via the tool result only.
- **The boundary is the sandbox.** Permission decides whether to ask; it does not confine
  anything. Assertions about confinement must read `sandboxEnforcement`, never the config.

## Decisions and rejected alternatives (with dates)

| Date | Decision | Rejected alternative / note |
| --- | --- | --- |
| 2026-09-09 | Permission = orthogonal `sandbox` × `approval`; `ceilingOf` + `decide` as separate pure functions | A single mode enum; a third `defaults` / `toolOverrides` layer — both were dead code once the matrix covered all four tiers, and were deleted |
| 2026-09-09 | `plan` removed as a permission concept | It is back as a first-class preset with a read-only boundary plus `save_plan` and plan store; the config is identical to `read-only` (`permission-presets.ts`) |
| 2026-09-09 | Fail-closed approval: dropped connection and interrupt deny pending calls, no timeout | A timeout was rejected — it turns a visible pending approval into a silent denial |
| 2026-09-09 | Sub-agents must not auto-allow `ask` | The shipped `createAutoAllowGate` for children was the branch's worst hole; it is now `createSubAgentApprovalGate` (deny) |
| 2026-09-09 | The same sandbox mode drives the shell **and** filesystem decorators | Keeping the fs tools unconfined while claiming `workspace-write` (the desktop host did this) |
| 2026-09-20 | Parameter rules: runner-resolved facts + tool-declared `pathInputs` / `hostInputs` | Hardcoding a tool→field table in core (unreachable for MCP); guessing path/URL fields from the schema; declaring `glob`'s `pattern` as a path; extracting paths out of `bash` |
| 2026-09-20 | Rules clamp to the ceiling; they cannot exceed it | The previous "rule wins outright" return, which let a config write through `read-only` |
| 2026-09-20 | `commandPrefix`: strict single simple command, argv-token prefix, allow-only, must name a tool | Segment-by-segment analysis of `;`/`&&`/`|`; deny/ask prefix rules; stripping "known safe" env assignments; `bash -c` introspection |
| 2026-09-20 | Interactive grants stay deleted; rules are hand-written files | `allow_always` inserting a session-scoped rule (deleted 2026-09-10; reversed by the next row) |
| 2026-09-20 | Reversal, same day: a one-click "remember" writes a durable rule into the config file | The prefix-rule spec had ruled out interactive grants; the remember design reintroduced the capability as a visible, editable, ceiling-clamped file entry that takes effect next turn |
| 2026-10-15 | Toolset governance: default visible set trimmed, with a floor table, `Infinity` default removed, host override replaces wholesale | Bare trimming to 20 (would cut the edit chain); host-supplied tables (every host that forgets one goes ungoverned); ToolSearch / schema deferral |
| 2026-10-30 | Skill catalog is read-only and lists winners only; `shadowed` shown in the host UI | Editing skills from the UI; previewing bodies (body/model divergence) |
| 2026-11-09 | Protocols are a provider concern; tool calls and results are normalized to one `ModelEvent` / `ToolResult` vocabulary, `cacheBreakpoints` are protocol-agnostic | Per-protocol tool gating or per-protocol tool definitions |
| 2026-11-13 (verified) | Limit is mode-dependent: `20 + 10 browser + 5 lsp + 1 memory`; browser group priority 45 | The earlier fixed 20/21 cap and 5-browser-tool table no longer hold; a bare 20 silently withheld four of five lsp tools |

## How to change it (tests to run, regression points)

| Intent | Files / symbols |
| --- | --- |
| New tool | `packages/tools/<group>/src/*.ts` (`defineTool`: `requires`, `riskTier`, declared parameter inputs), then the SDK assembly and `tool-scope-default.ts` membership; regenerate the user-facing tool reference (`pnpm docs:gen`) |
| New capability | the tool's `requires` + the grant in `create-agent.ts:1620-1695`; a capability nobody grants silently removes its tools |
| New preset / changed matrix | `permission-presets.ts`, `permission-policy.ts` (`decide`), and the picker copy in the hosts |
| New rule dimension | `ToolDefinition` declaration field, `PermissionRule`, `ruleMatches`, the runner-side fact collection, **and** both validators (`config/permissions.ts`, `agent-registry/frontmatter.ts`) |
| New approval channel | an `ApprovalGate` implementation plus its fail-closed paths; keep `ApprovalDenialReason` meaningful |

Static gates (affected packages only; never the whole repo, never `@voltojs/desktop-app`):

```bash
pnpm turbo run typecheck lint test --filter @voltojs/core
pnpm turbo run typecheck lint test --filter @voltojs/runtime-node --filter @voltojs/sdk
pnpm turbo run typecheck lint test --filter @voltojs/gateway
pnpm turbo run build --filter @voltojs/sdk   # tools/runtime/sdk consume dist, not source
```

Tests that encode the contracts above:

| Area | Tests |
| --- | --- |
| Matrix, rules, clamp, narrowing | `packages/core/src/__tests__/permission-policy.test.ts`, `permission-presets.test.ts`, `narrow-permission.test.ts` |
| Command tokens and risk labels | `command-match.test.ts`, `command-risk.test.ts` |
| Reminder text and injection | `permission-prompt.test.ts`, `permission-injection.test.ts` |
| Visibility and router | `tool-router.test.ts`, `tc-e9-capability-permission.test.ts` |
| Replay determinism | `permission-mode-replay.test.ts` (core purity gate — run after any reducer or policy change) |
| Runner enforcement | `packages/runtimes/node/src/__tests__/approval-gate.test.ts`, `tool-input-facts.test.ts`, `fs-tool-executor.test.ts` |
| SDK wiring | `permission-context.test.ts`, `path-rules-wiring.test.ts`, `lsp-db-wiring.test.ts`, `browser-tools-assembly.test.ts`, `agent-depth.test.ts`, `agent-spec.test.ts` |
| Gateway approval and rules | `approval-gate.test.ts`, `config-permissions.test.ts`, `remember-rule-e2e.test.ts`, `permission-modes.test.ts`, `ask-user-e2e.test.ts` |

Regression points worth stating explicitly, because each was a real defect once:

- Assert the **decision** and the **visible set**, never "the call produced no output".
- A rule must not widen anything above the ceiling; a client must not be able to send a
  rule through `POST /approvals`.
- A sub-agent must never be able to reach a permission wider than its parent's.
- A denied or interrupted `tool_use` must still receive a result.
- The gateway's pending approvals must deny on detach and interrupt, and only the
  connection that saw the card may settle it.
- After a `remember` save, the rule takes effect on the next turn — do not "fix" the same
  turn, the timing is the contract.

## Further reading

Archive, frozen at the time of writing (paths relative to `docs/archive/`; search with
`docs/archive/INDEX.md`):

| Spec | What it explains |
| --- | --- |
| `superpowers/specs/2026-09-09-permission-redesign-design.md` | The two-knob model and the presets |
| `superpowers/specs/2026-09-09-permission-enforcement-gaps.md` | Wiring defects found after the redesign; most are fixed, the list records how the gaps looked |
| `superpowers/specs/2026-09-20-parameter-permission-rules-design.md` | Path / host rules, the ceiling clamp, the resolver split |
| `superpowers/specs/2026-09-20-shell-command-prefix-rules-design.md` | The strict argv allowlist and its residual risks |
| `superpowers/specs/2026-09-20-approval-remember-rule-design.md` | The one-click rule write, and why it is a file rather than a session grant |
| `superpowers/specs/2026-10-15-toolset-governance-design.md` | The five-tier visibility table |
| `superpowers/specs/2026-10-30-skill-catalog-design.md` | The read-only skill catalog and `shadowed` |
| `superpowers/specs/2026-11-09-three-protocol-routing-design.md` | Why tool calls and results are protocol-agnostic |

Related current pages: `docs/dev/runtime-and-sandbox.md` (the boundary behind these
decisions), `docs/dev/security.md` (threat model and known gaps), `docs/dev/sdk-and-extensibility.md`
(sub-agent assembly, plugins, MCP), `docs/dev/core-loop.md` (reducer states and hooks).
`SAFETY.md` is the authority on what permission machinery does not promise.