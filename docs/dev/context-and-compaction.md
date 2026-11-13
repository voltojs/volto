---
title: Context and compaction
status: current
source:
  - packages/core/src
verified: 2026-11-13
supersedes:
  - docs/archive/superpowers/specs/2026-09-03-context-assembler-content-layers-design.md
  - docs/archive/superpowers/specs/2026-09-06-context-usage-meter-design.md
  - docs/archive/superpowers/specs/2026-09-07-context-usage-precision-design.md
  - docs/archive/superpowers/specs/2026-09-11-context-reminder-audit-design.md
  - docs/archive/superpowers/specs/2026-09-15-context-compaction-alignment-design.md
  - docs/archive/superpowers/specs/2026-09-25-workflow-mode-reminder-design.md
  - docs/archive/superpowers/specs/2026-10-16-spill-design.md
  - docs/archive/superpowers/specs/2026-10-16-compaction-image-offload-design.md
  - docs/archive/superpowers/specs/2026-10-23-tokenizer-calibration-design.md
  - docs/archive/superpowers/specs/2026-10-23-tool-result-pruning-policy-design.md
  - docs/archive/superpowers/plans/2026-10-23-anchored-compaction-budget.md
  - docs/archive/superpowers/specs/2026-11-10-workspace-context-injection-design.md
---

# Context and compaction

## Scope and where it sits

This page covers the five things that decide what the model sees on a request surface and
how large it is: **assembly order**, **compaction**, **token accounting**, **truncation**,
and **spill**. Decision logic lives in `@voltojs/core`; the imperative halves (store
writes, the summarization call) live in the Node Runner and its hosts.

The core modules are `context-assembler.ts` (ordering and static prefix, `assembleContext`),
`compactor.ts` (`decideCompaction`), `compaction-budget.ts`
(`deriveCompactionMaxTokens`), `prompt-budget.ts` (`PromptAnchor`, `estimateFromAnchor`,
fallback pricing), `text-extract.ts` (extraction and per-block pricing),
`context-usage.ts` (read-side meter), `tool-result-prune.ts`, `tool-result-spill.ts`,
`compaction-image-offload.ts`, and `heuristic-tokenizer.ts` — all under
`packages/core/src/` unless stated otherwise.

Two call sites share the pure core:

- **Pure path.** `reducer.ts` `buildCallModelEffect()` calls `assembleContext` for every
  `call_model` effect. The reducer is the only writer of `state.messages`.
- **Runner path.** `packages/runtimes/node/src/runner.ts` `runModelStream()` compacts,
  calls `assembleContext` on the post-feed messages, then injects RAG at the prefix
  boundary. Compaction and pruning re-enter the reducer as `AgentInput`s
  (`compaction_applied`, `tool_results_pruned`); the Runner never mutates state itself.

## Current behavior

### Assembly order and the static prefix

`assembleContext(opts)` partitions `opts.messages` in one pass:

1. **System messages** (`role === "system"`), original order.
2. **Context layers**: one synthesized system message per `ContextLayer`, id
   `layer-<layer.id>`, content `layer.text`. Non-empty `opts.todos` appends a synthetic
   layer with id `TODO_LIST_LAYER_ID` (`"todo-list"`) formatted by `formatTodoListForModel`.
3. **Pinned messages**: those whose `id` is in `pinnedMessageIds`.
4. **Everything else**, chronological order preserved.

`staticPrefixLength` is the size of 1–3. `cacheBreakpoints` is `[0]` plus `prefixLen` when
`0 < prefixLen < messages.length`, and nothing else. `layerOrigins` maps each layer id to
`systemMessages.length + i`; `context_assembled` is recorded only when a layer exists.

Tools are not embedded in messages; they travel in `ModelRequest.tools`. Layers come from
the host (`workspace-instructions.ts` ids `user-memory:<path>` / `project-memory:<path>`,
plus `skill-catalog`); one message per layer means only the changed layer invalidates the
cache behind it. Its `systemPrompt` and `tools` options are declared but never read — only
`messages`, `pinnedMessageIds`, `contextLayers`, and `todos` are consumed.

Two content classes are added *outside* the assembled prefix:

- **Tail reminders.** Permission-boundary, workflow-mode, and workspace reminders are
  user-role `<system-reminder>` messages appended by the reducer's `handleIdle`
  `user_message` branch before the new user message, so a mid-session change never
  invalidates the cached prefix.
- **RAG injection.** After assembly, `runModelStream` inserts one `role: "user"` message
  (`id: "rag-injection"`) at
  `computeRAGInjectionIndex({ staticPrefixLength, totalMessages })` — the prefix boundary.
  The text is capped at `RAG_MAX_CHARS = 4000` code points with a trailing `\n(truncated)`;
  retrieval is per-turn cached, so every call in the turn injects the same text.

### Compaction threshold

`deriveCompactionMaxTokens` (`compaction-budget.ts`) is the single formula:

```
messageBudget  = floor(window) - maxOutputTokens
pressureBudget = messageBudget - headroom
threshold      = max(1, floor(min(window * ratio, pressureBudget)))
```

- Unknown / non-positive / non-finite `window` → `DEFAULT_COMPACTION_MAX_TOKENS` (60,000).
- `headroom` defaults to `min(65_536, floor(window * 0.1))`; an explicit value is honored.
- `ratio` defaults to `0.8`; values outside `(0, 1)` fall back to it.
- `pressureBudget <= 0` throws (`compaction budget exhausted`).

`createAgent` derives this only when the host enabled compaction (an explicit `maxTokens`
wins). The gateway resolves it **default-on** with `DEFAULT_COMPACTION` =
`{ recentKeepCount: 4, toolResultMaxChars: 8192, summaryMaxTokens: 4096 }` and no
`maxTokens`; sub-agents get their own window-derived config. The SDK always wires
`spill: { store: createNodeSpillStore({ rootDir: cwd }) }` (the Runner option is optional).

### What `decideCompaction` selects

`currentTokens = measuredTokens ?? estimateTokens(messages) + reservedTokens`. When
`currentTokens <= maxTokens`, `shouldCompact` is false and the array passes through.

Otherwise:

- System messages are preserved unconditionally; the last `recentKeepCount` **non-system**
  messages are preserved (clamped) and all other non-system messages are candidates.
- **Absolute exemptions**: ids in `pinnedMessageIds`, `isPermissionReminder` (a
  `<system-reminder>` containing "permission boundary for this session",
  case-insensitive), and `isEnvironmentReminder` (`<system-reminder>` containing
  `\nWorking directory: `). These leave the candidate set entirely — their fingerprints do
  not change, so they are never re-announced.
- **Sort key only**: `isKeyMessage` (file paths via `extractFilePaths`, incomplete todos
  via `hasIncompleteTodos`, or either reminder) sorts a message *after* non-key messages,
  so key content is compressed last, not exempted.
- Candidates sort key-last, then tool interactions first (`isToolInteraction`), then oldest
  first; a greedy pass selects until the overage (`currentTokens - maxTokens`) is covered.
- `pairToolInteractions` runs to a fixpoint: a selected `tool_use`/`tool_result` pulls in
  its partner if the partner is still a candidate. A pinned, recent-kept, or exempt partner
  is left alone ("soft" pairing).
- `replacedIds = compressedIndices.map(i => messages[i].id)`; `compressibleMessages` is in
  original index order; `preservedMessages` is system plus unselected others.
  `estimatedTokensAfter = estimateTokens(preservedMessages) + 200` — the `200` is a fixed
  summary placeholder and nothing reads it.

`buildSummaryPrompt` emits a fixed-section checkpoint (`Primary Request and Intent`, `Key
Technical Concepts`, `Files and Code`, `Errors and Fixes`, `Pending Jobs`, `Current Work`,
`Next Step`, `Critical Context`), requires `(none)` for empty sections, verbatim
paths/commands/identifiers, and merging a prior summary. Section text comes from
`extractMessageText`, so reasoning is omitted and images become placeholders there.

### The compaction sequence in the Runner

`runModelStream` → `applyCompaction` → `runCompactionWriteBack`:

1. Decide. `preCompact` hooks then run; a `deny` returns the **original** array unchanged
   and emits `preCompact_skipped`.
2. Unless `prunePolicy === "off"` (default `"pressure"`), `pruneOversizedToolResults`
   rewrites oversized text blocks in every `role: "tool"` message. A configuration error is
   caught and degrades to "no prune" (`createAgent` validates the budget at construction).
3. Feed `tool_results_pruned` if any entry survived. Entries carry `toolCallId`,
   `charsBefore`, `charsAfter`, `content`, `savedTokens`; the first also carries
   `cacheResetTokens` (prefix up to the first pruned message plus reserved tokens) and
   `cacheResetEstimated: true`. The reducer replaces content in place, and the Runner
   clears the prompt anchor.
4. `surface` is the post-feed `state.messages` when a prune landed, else the original
   array. Re-decide only if something was written back, carrying
   `max(0, measuredTokens - totalSavedTokens)` so a pressure-relieving prune does not pay
   for a summary.
5. If still over threshold, `ModelPort.stream` gets only the summary prompt (`tools: []`,
   `maxTokens: summaryMaxTokens ?? 4096`). Its `usage` is accumulated into the turn and
   attached to the compaction event. A stream error or empty summary aborts the write-back
   and returns the pruned surface.
6. If `replacedIds` is non-empty, image offload runs first:
   `planImageOffload(compressibleSpan, { maxImages: preserveImageCount ?? 4 })` keeps the
   **last N** images in span order, degrades older ones to `[image: WxH mediaType]`
   placeholders prefixed to the summary, and returns `toOffload` (inline base64 survivors).
   Each survivor is `put` under `deriveDeterministicId(messageId + idSuffix)`; a missing
   store, failed put, or pairing failure degrades that image and emits
   `attachment_unavailable`. `preserveImageCount <= 0` skips the phase.
7. Feed `compaction_applied { summaryId, summaryText, replacedIds, preservedImages?, usage? }`;
   `summaryId` comes from the `Id` port (`stepContext.id?.next()`, fallback
   `summary-${stepCounter}`).

The reducer's `compaction_applied` branch removes `replacedIds`, inserts the summary as a
**user-role** message `[Earlier conversation summary]\n<text>` at the earliest replaced
position in kept order, inserts a user-role carrier `${summaryId}-images` right after it
when images survived (content `[marker, image, marker, image, …]`, marker from
`renderImagePreservedMarker`), drops replaced pins, and emits `compaction` with
`replacedCount`, `summaryText`, `replacedIds`, `summaryId`, `usage`, and ref-only
`preservedImages`. The next request is assembled from post-feed `state.messages`.

`transcript-projection.ts` replays the same rewrite, including the carrier, from ref
metadata. It skips events without `replacedIds`/`summaryId` and skips when no projected
message id matches — its comment notes production events lack the ids needed, so that
replay is effectively a no-op there.

### Manual compaction

`Runner.compactNow()` runs the same write-back path while the agent is `idle` or `done`;
any other status throws `CompactionBusyError` (code `"busy"`, mapped to HTTP 409). It
returns `null` when no compaction config exists or nothing was written back, otherwise
`{ replacedCount, tokensFreedEstimate }` (tokenizer delta over `state.messages` before and
after; a prune-only pass returns `replacedCount: 0`). The gateway route is
`POST /sessions/:id/compact`.

### Truncation

Truncation is code-point based throughout; three rules apply:

- **Tool-result pruning** (`pruneOversizedToolResults`). Per text block over `maxChars`
  (default 8192; head 4096, tail 1024 — `resolvePruneOptions` rejects
  `head + tail >= maxChars`), output is `head + "… [omitted N chars] …" + tail`; if the
  marked result would exceed `maxChars`, the block is left untouched rather than grown.
  Structured blocks degrade to a `text` block before the cut (a partial structured
  projection would lie); images are never touched. There is no `isError` exemption: error
  results are pruned the same way. Defaults are 50% / 12.5% of the budget.
- **RAG cap** (`RAG_MAX_CHARS`). Cuts at `4000 - len("\n(truncated)")`, backs off to the
  last complete block boundary, appends `\n(truncated)`, and reports the surviving count.
- **Image placeholders.** `extractBlockText` renders `[image: WxH mediaType]` (dimensions
  omitted unless both are known); `resolveImageRefs` renders `[image unavailable: <id>]`.

Tool packages impose their own caps before results reach this layer (bash and `web_fetch`
100,000 chars, vcs 20,000); spill assumes text is already bounded.

### Spill

`applySpill(toolCallId, result)` runs in `executeTool` after the `postToolUse` hook and
before the result reaches the reducer. It acts only when a `spill.store` exists,
`result.isError` is false, and `modelContent` is a string; `decideSpill` then compares code
points against `thresholdChars` (default 16,000) and returns the first `headChars` code
points (default 2,000) plus the full text.

A spill writes the full text through `SpillStore.write`, sets
`modelContent = keptHead + renderSpillReference({ relativePath, totalChars })`, and adds
`displayMetadata: { spilled: true, spillPath, totalChars }`. The reference is a
cross-package contract and must stay byte-identical:

```
\n\n[output truncated: <N> chars total; full output saved to <path> — read it with read_file if needed]
```

A store write that throws emits `spill_failed { toolCallId, error }` and returns the
**original** result; the loop is never interrupted. `createNodeSpillStore` writes
`<rootDir>/.volto/spill/<sessionId>/<toolCallId>.txt`, rejects non-segment ids, resolves
`realpath` for the spill root and session directory, removes a symlink squatting on the
target name, and overwrites (idempotent for a repeated id).

A spilled result (~2,000 code points plus the reference) stays below the 8,192 prune
budget, so the layers normally do not interact. With `pruneSpill` they do: the prune pass
writes the full original through the same store first and skips candidates containing
`full output saved to`; a failed backup write drops that entry and emits `spill_failed`.

## Token accounting and the Tokenizer port

The port is minimal (`ports.ts`): `interface Tokenizer { count(text: string): number }`.
Every consumer takes a tokenizer argument; nothing in core constructs one.

- **Production default** — `createHeuristicTokenizer(bytesPerToken = 4)`:
  `max(1, ceil(utf8ByteLength(text) / 4))`, `0` for empty text. The unit is UTF-8 bytes,
  not UTF-16 code units, so CJK is no longer systematically undercounted.
- **Delegation** — `createNodeTokenizer` (`runtimes/node/src/tokenizer.ts`),
  `createBrowserTokenizer`, and the SDK's `defaultTokenizer` delegate to the core factory;
  `apps/web` reaches it through `@voltojs/sdk/sse`.
- **Tests only** — `createCharTokenizer` (`core/src/testing/char-tokenizer.ts`) keeps
  UTF-16 code-unit semantics on purpose; `createFixedTokenizer` returns a constant. A
  tiktoken adapter and a per-model `tokenizerBytesPerToken` factor are **not** implemented.

Pricing helpers (`text-extract.ts`), shared by compaction and the usage meter: a
text/reasoning/structured block costs `count(text) + 4`; `tool_use` costs
`count(name) + count(JSON.stringify(input)) + 4`; an image costs `estimateImageTokens(w, h)
+ 4`; a `tool_result` costs the nested sum `+ 4`; string content costs `count(content) + 4`;
and each message adds a further `+ 4` (`estimateMessageTokens`).

`estimateImageTokens` is `ceil(width * height / 750)`, falling back to
`IMAGE_TOKEN_FALLBACK = 1600` when dimensions are unknown — deliberately conservative and
explicitly an estimate; providers bill images differently. `extractMessageText` (the
display/summary extractor) zeroes reasoning blocks, so it must not be used for pricing;
`estimateContentTokens` / `estimateBlockTokens` are the pricing path and price reasoning
like text because reasoning rides in the provider request.

**Compaction pressure.** `prompt-budget.ts` defines the anchor:

```ts
interface PromptAnchor { totalTokens; messageIndex; headerHash; trusted }
```

- `estimateFromAnchor` returns `undefined` unless the anchor is trusted, `messageIndex` is a
  non-negative integer, and `messageIndex <= messages.length`; otherwise
  `anchor.totalTokens + estimateTokens(messages.slice(anchor.messageIndex))`.
- `totalTokens` is `totalUsageTokens(usage)` = input + output + cacheRead + cacheWrite, and
  `messageIndex` is `state.messages.length` **after** the call's assistant message landed,
  so the output already inside `totalTokens` is not counted twice.
- The Runner builds `measuredTokens` only when the current request-header hash equals the
  anchor's; a changed tool set, model, sampling params, or layer set invalidates it. The
  anchor is replaced in `runModelStream`'s `finally` when usage was captured:
  `trusted = requestEstimate !== undefined && total >= requestEstimate`, where
  `requestEstimate = estimateTokens(finalMessages) + estimateToolDefinitionTokens(tools)`.
  Under-reported usage never seeds a trusted anchor.
- `compaction` and `tool_results_pruned` events set `promptAnchorState.anchor = undefined`
  (the surface was rewritten). The anchor lives outside `AgentState`, is never serialized,
  and is shared across per-turn Runners only through the `promptAnchor` holder.
- Without a trustworthy anchor, `decideCompaction` adds `reservedTokens`
  (`estimateContextLayerTokens` + `estimateToolDefinitionTokens`) to the absolute estimate;
  with an anchor it adds nothing. The fallback estimators differ slightly from the usage
  meter: tool schemas are priced per tool from `{name, description, inputSchema}` and
  layers without a role overhead, whereas `estimateHeader` serializes the whole tool array
  once and adds one role overhead.

**Calibration.** Once per turn, with usage captured and a positive estimate, the Runner
emits the raw `tokenizer_calibration` event (`EventSink`, not transcript) with
`{ model, estimated, provider, ratio, source }`. `source` is `"anchor"` (estimate from
`measuredTokens`; `provider` is the same total) or `"absolute"` (`provider` is the
prompt-only sum). The event never changes a decision.

**Context usage meter.** `context-usage.ts` keeps two counters: `pendingTokens` (reset by
every measured `assistant_message`) and `messageTokens` (reset only by `compaction`). Per
event: `request_header` replaces/prices the header; `assistant_message` re-anchors and adds
the response; `tool_result`, `user_message`, and `steering_queued` add to both;
`steering_delivered/edited/removed` are explicit no-ops (priced at queue time);
`compaction` resets `pendingTokens` to 0 and `messageTokens` to `count(summaryText) + 4`.

`projectedTokens` is `anchor.promptTokens + anchor.outputTokens + pendingTokens` when
anchored, else `system + tools + messageTokens`. `breakdown` is three independent estimates
and deliberately does not sum to `projectedTokens`. The production transport is
`ContextUsageSnapshot` (`headerEstimate` plus counters, no text): the gateway folds stored
events with `foldSnapshotEvent`, the web app continues folding live SSE events, and
`snapshotView` is the single projection implementation. `ContextUsageFold`,
`computeContextUsage`, and `contextUsageView` are the fold-shaped oracle used by the
snapshot-equivalence tests only.

## Invariants and boundaries

- **Purity.** No I/O, clock, randomness, or ID generation here; the tokenizer is injected
  and spill/image offload are decisions only, so the same input yields the same `(state,
  effects)`.
- **The reducer is the only writer of `state.messages`.** Compaction and pruning are
  `AgentInput`s; the transcript stays append-only and `transcript-projection.ts` must
  replay an equivalent history.
- **Static prefix first.** System messages and layers precede pinned messages and history;
  the summary is user-role so it stays *after* the prefix, or the cache breaks.
- **Compaction is a boundary operation.** It runs before a request in `runModelStream`, or
  on demand through `compactNow` while idle/done — never mid-tool-batch.
- **Failures degrade, never throw.** Summary failure returns the pruned surface; prune
  config errors degrade to no prune; spill write failures return the original result; image
  offload failures degrade to placeholders.
- **Guards against degenerate write-backs.** An empty summary feeds nothing; an empty
  `replacedIds` is not fed (it would prepend a summary with nothing replaced); unknown ids
  are tolerated.
- **Spill is text-only and model-readable.** It is not a tool, needs no capability, and
  writes inside the workspace (`.volto/spill/`) — deliberately not the attachment store's
  non-readable `~/.volto` area.
- **Anchors are not state.** They are host-side, header-hash scoped, and absent after a
  rebuild/restart; the absolute estimate is the always-available fallback.

## Decisions and rejected alternatives (with dates)

- **2026-09-03 — one message per layer, never merged.** Separate `ContextLayer`s plus
  `layerOrigins` let audits attribute text to a source, and only the changed layer
  invalidates the cache behind it. Rejected: merging layers (loses provenance); a dynamic
  variant on `ContextLayer` (RAG injects after assembly); MCP resources as layers.
- **2026-09-07 — no forced reconciliation of the usage breakdown.** The residual
  `messages = projected - system - tools` and the `Math.max(...)` floor were removed; the
  code keeps three independent estimates. Do not "fix" `breakdown` to sum.
- **2026-09-11 — closed reminder union.** `ContextReminderKind` is an explicit union, not
  the earlier design's open `source:{kind,form}` tags; volto has no out-of-repo plugin writing events. Its
  statement that compaction does not write back `state.messages` is obsolete since the
  2026-09-15 write-back plan.
- **2026-09-15 — input-feed write-back.** Rejected: the Runner mutating `state.messages`
  (breaks purity/replay) and a parallel `modelHistory` (a second source of truth). The
  design specified a `system`-role summary; the code uses `user`-role — a reversal, because
  a system summary is hoisted ahead of the static layers. The spec's "error results get a
  longer head" did not land either: pruning has no error path.
- **2026-09-25 — workflow-mode reminders are tail-injected and unprotected.** Rejected:
  pinning them (changing the pinned set changes the prefix) and compactor-specific
  protection (content sniffing). Loss on compaction is accepted and still the behavior;
  the workspace reminder later got an exemption, workflow text did not.
- **2026-10-16 — runner-level spill.** Rejected: per-tool spill (thresholds and reference
  text drift per package; tools may only type-import core) and spilling only at compaction
  time; a JSON envelope reference; a path-only reference; `os.tmpdir()` (unreadable through
  the workspace-bounded `read_file`); uuid filenames (break byte-identical replay). Chosen:
  16,000/2,000 code points, `.volto/spill/<sid>/<toolCallId>.txt`, the text reference above.
- **2026-10-16 — image offload keeps refs, offloads inline bytes, caps at 4.** Rejected: a
  system-message block array carrying images (the wire witness showed system content is
  text-only on all providers) and re-`put`ting existing refs; the code uses a separate
  user-role carrier and deterministic ids, as in the v1.2 design.
- **2026-10-23 — anchored budget.** Rejected: a bare absolute heuristic plus a 0.6 safety
  coefficient (the coefficient was removed) and tiktoken as a core dependency (deferred;
  the port remains the extension point). The threshold became
  `min(0.8 × window, window − output − headroom)`, headroom scaled to
  `min(65,536, 10% of window)`. Rejected: storing the anchor in `AgentState` (not
  replayable state) and learning/writing back per-model factors.
- **2026-10-23 — prune first, then re-measure.** Rejected: "overage-minimal set" selection
  (prune *all* oversized results; a following summary subsumes the cache cost) and giving
  every pruned result a spill backup by default (`pruneSpill` is opt-in). Pricing
  `cacheResetTokens` from an anchor also did not land: the code uses the local prefix
  estimate and marks `cacheResetEstimated: true`; `sourceEventSeq` was deferred in favor of
  `toolCallId` as the join key.
- **2026-11-10 — workspace reminder, not a static environment layer.** Rejected: resolving
  directory/branch once into `contextLayers` (worktrees make it change mid-session) and
  splicing it into the system prompt. The reminder is a tail `<system-reminder>` with a
  fingerprint, and it joins the compactor's absolute exemptions because it is never
  re-announced, like the permission boundary.

## How to change it (tests to run, regression points)

Static gates, per affected package (never the whole repo, never `@voltojs/desktop-app`):

```
pnpm turbo run typecheck lint test --filter @voltojs/core
pnpm turbo run typecheck lint test --filter @voltojs/runtime-node
pnpm turbo run typecheck lint test --filter @voltojs/sdk
pnpm turbo run typecheck lint test --filter @voltojs/gateway
```

Tests that pin this behavior:

| Area | Tests |
| --- | --- |
| Assembly, layers, breakpoints, todos | `context-assembler.test.ts`, `todo-assembler.test.ts`, `todo-compaction-immunity.test.ts` |
| Decision, exemptions, pairing, summary prompt | `compactor.test.ts` (`the workspace reminder is exempt`, `soft tool pairing`, `structured summary prompt`) |
| Threshold and anchor arithmetic | `compaction-budget.test.ts`, `prompt-budget.test.ts` |
| Write-back | `compaction-writeback.test.ts`; `replay.test.ts`, `transcript-projection.test.ts` |
| Prune / spill / image plan | `tool-result-prune.test.ts`, `tool-result-spill.test.ts`, `compaction-image-offload.test.ts`, `image-token-estimate.test.ts` |
| Tokenizer and usage meter | `heuristic-tokenizer.test.ts`, `context-usage.test.ts` (snapshot equivalence, no full text, double counting, no floor) |
| Runner wiring | `runner-compaction.test.ts`, `runner-spill.test.ts`, `runner-image-offload.test.ts`, `runner-image-refs.test.ts` |
| SDK / gateway | `sdk/__tests__/compact-now.test.ts`, `compaction-window.test.ts`, `gateway/__tests__/compact-endpoint.test.ts`, `compaction-window-session.test.ts` |

Regression points:

1. **Replay.** Any reducer change (including `compaction_applied` /
   `tool_results_pruned`) must keep `(state, effects)` identical across two runs.
2. **Prefix stability.** New static content belongs in a new layer, never in the system
   prompt string and never in `contextLayers` when it can change mid-session; anything
   appended mid-session goes in as a tail message.
3. **Two estimators, one truth.** Changing a price (`BLOCK_OVERHEAD`, `ROLE_OVERHEAD`, the
   bytes-per-token density, image pricing) moves both compaction and the meter; update
   `context-usage.test.ts` and `prompt-budget.test.ts` together and re-run snapshots.
4. **Marker strings are contracts.** `renderSpillReference`'s `output truncated:` /
   `full output saved to` substrings are used by the prune path to skip already-spilled
   results; changing them silently breaks that exemption.
5. **Write-back must stay an input.** Do not shorten `state.messages` from the Runner; feed
   an input and let the reducer rewrite, or projection and resume diverge.
6. **Threshold changes touch hosts.** `deriveCompactionMaxTokens` is shared by
   `createAgent`, sub-agents, and the gateway's default-on config; update the formula tests
   and the window-session integration tests.

## Further reading

- [Archive index](../archive/INDEX.md) — locate every spec/plan by date and module.
- [Context assembler layers (2026-09-03)](../archive/superpowers/specs/2026-09-03-context-assembler-content-layers-design.md),
  [usage meter (2026-09-06)](../archive/superpowers/specs/2026-09-06-context-usage-meter-design.md),
  [precision (2026-09-07)](../archive/superpowers/specs/2026-09-07-context-usage-precision-design.md), [reminder audit (2026-09-11)](../archive/superpowers/specs/2026-09-11-context-reminder-audit-design.md)
  — layers, anchor + delta projection, the snapshot boundary, the reminder union.
- [Compaction alignment (2026-09-15)](../archive/superpowers/specs/2026-09-15-context-compaction-alignment-design.md),
  [workflow-mode reminder (2026-09-25)](../archive/superpowers/specs/2026-09-25-workflow-mode-reminder-design.md)
  — write-back architecture, span selection, structured checkpoint, tail injection.
- [Spill (2026-10-16)](../archive/superpowers/specs/2026-10-16-spill-design.md),
  [image offload (2026-10-16)](../archive/superpowers/specs/2026-10-16-compaction-image-offload-design.md),
  [tokenizer calibration (2026-10-23)](../archive/superpowers/specs/2026-10-23-tokenizer-calibration-design.md),
  [pruning policy (2026-10-23)](../archive/superpowers/specs/2026-10-23-tool-result-pruning-policy-design.md), [anchored budget plan (2026-10-23)](../archive/superpowers/plans/2026-10-23-anchored-compaction-budget.md)
  — interception, reference format, deterministic ids, thresholds, prune-first ordering.
- [Workspace context injection (2026-11-10)](../archive/superpowers/specs/2026-11-10-workspace-context-injection-design.md)
  — why the workspace reminder is a tail injection and why it is compaction-exempt.