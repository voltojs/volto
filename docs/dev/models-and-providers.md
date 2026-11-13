---
title: Models and providers
status: current
source:
  - packages/providers
  - packages/core/src
  - packages/sdk/src
  - apps/gateway/src
verified: 2026-11-13
supersedes:
  - docs/archive/superpowers/specs/2026-07-24-provider-model-management-design.md
  - docs/archive/superpowers/specs/2026-09-08-reasoning-effort-and-pi-ai-providers-design.md
  - docs/archive/superpowers/specs/2026-09-23-model-input-fields-design.md
  - docs/archive/superpowers/specs/2026-10-29-model-routing-tiers-design.md
  - docs/archive/superpowers/specs/2026-11-09-three-protocol-routing-design.md
  - docs/archive/superpowers/plans/2026-09-08-reasoning-effort-core-contract.md
  - docs/archive/superpowers/plans/2026-09-08-pi-ai-provider-port.md
  - docs/archive/superpowers/plans/2026-09-23-model-input-fields.md
  - docs/archive/superpowers/plans/2026-10-29-model-routing-tiers.md
  - docs/archive/superpowers/plans/2026-11-09-three-protocol-routing.md
---

# Models and providers

## Scope and where it sits

`ModelPort` is the seam between the pure kernel and an LLM vendor. The contract
lives in `packages/core/src/ports.ts` (`ModelPort`, `ModelRequest`,
`ModelEvent`, `TokenUsage`, `ResolvedModelInfo`, `ReasoningEffortId`); the core
never imports an implementation. The reducer emits a `CallModelEffect`
(`packages/core/src/effect.ts`) assembled by `buildCallModelEffect`
(`packages/core/src/reducer.ts`), and the Node Runner's `runModelStream`
(`packages/runtimes/node/src/runner.ts`) builds the `ModelRequest` and iterates
`modelPort.stream(req)`.

Three adapters exist:

| Adapter | Factory | Wire | Used by |
| --- | --- | --- | --- |
| `@voltojs/provider-pi-ai` | `createPiAiModelPort` | pi-ai `Models` (three protocols) | `apps/gateway/src/wiring.ts`, `apps/desktop-app/src/main/agent/wiring.ts` |
| `@voltojs/provider-openai` | `createOpenAIModelPort` | `POST /v1/chat/completions` | no host; tests only |
| `@voltojs/provider-anthropic` | `createAnthropicModelPort` | `POST /v1/messages` | no host; tests only |

Provider selection is a construction-time decision, not a request field:
`ModelRequest` has no provider id, and `StepContext.providerId` is provenance
stamped onto `assistant_message.source`, never a routing predicate. Swapping
providers means swapping the `ModelPort` — for a new turn (gateway `rebuild()`
in `apps/gateway/src/sessions.ts`) or for one sub-agent dispatch.

The gateway resolves `{providerId, modelId}` via
`createProviderStore().resolveModel` (`apps/gateway/src/config/providers.ts`),
projects it with `buildProviderConfig`, and hands the result to
`createWiredAgent`. Nothing reads credentials from the environment: pi-ai's
`fixedApiKeyAuth` exists so its `envApiKeyAuth` fallback never runs
(`packages/providers/pi-ai/src/collection.ts`).

## The ModelPort contract (streaming, tool calls, errors, usage)

### Interface and request

```ts
interface ModelPort {
  stream(req: ModelRequest): AsyncIterable<ModelEvent>;
  describeModel?(model: string): Promise<ResolvedModelInfo>;
}
```

`ModelRequest` carries `messages`, `tools`, `model`, `maxTokens`, `temperature`,
`reasoningEffort`, `abortSignal`, `responseFormat`, `cacheBreakpoints`,
`layerOrigins`. `describeModel` is optional by design, but the gateway's pi-ai
route calls it for effort validation, protocol audit, context-window sizing and
sub-agent capability facts, so a port wired there must implement it.

### Streaming and the terminal rule

`stream` must end in exactly one terminal event, `done` or `error`. The Runner
treats a stream that merely stops as a truncated response: streamed text with no
open tool call synthesizes `model_done` with `end_turn` and fails the turn;
otherwise it feeds `model_error`. A cut inside a tool call must never become an
assistant message with an unpaired `tool_use`.

`stopReason` is closed: `end_turn`, `tool_use`, `max_tokens` (OpenAI
`stop`/`tool_calls`/`length`; Anthropic `end_turn`/`tool_use`/`max_tokens`;
pi-ai `stop`/`deferred`/`toolUse`/`length`). `done.meta` is adapter-private
replay state, stored as `AssistantMessage.modelMeta` and never read by core.

### Tool calls

Calls arrive as `tool_use_start` followed by `tool_use_delta` fragments. The
reducer opens a pending call only when `toolCallId` **and** `toolCallName` are
truthy, so a nameless start is lost — which is why the pi-ai adapter reads the
name from `event.partial.content[event.contentIndex]` instead of trusting
`toolcall_start`. The OpenAI adapter buffers argument-only chunks until id/name
arrive (`pendingArgs`). At `model_done`, `buildAssistantContent` assembles the
blocks; argument text that does not parse as JSON becomes `{}` and the tool
router reports the schema error, never aborting the turn.

### Errors

Adapters never throw out of the stream. Provider failures become
`{ type: "error", error, retriable }`. The Runner feeds every error event to the
reducer as `ModelError` with `retriable` unchanged (`modelEventToInputs`); the
reducer decides. A retriable error increments `iterationCount` and re-issues
`call_model` unless the runaway guard fires; a non-retriable error closes the
turn (`handleCallingModel`, `packages/core/src/reducer.ts`). Only a *thrown*
exception (a broken port) reaches the Runner's `retryPolicy`, where
`classifyError` (`packages/core/src/error-taxonomy.ts`) applies exponential
backoff with a circuit breaker.

Adapter conventions: OpenAI and Anthropic mark `>= 500`, `429`, network failures
and empty bodies retriable; aborts and pi-ai stream errors are not. pi-ai
defaults to non-retriable because its error event carries no status code or
error class. A user cancel is not an error: the Runner checks `cancelled` first
and feeds `cancel` instead, so the turn closes as `cancelled`.

### Usage

Usage is a separate `ModelEventUsage` (extends `TokenUsage`): `inputTokens` (the
*uncached* prompt), `outputTokens`, optional `totalTokens`, `cacheReadTokens`,
`cacheWriteTokens`, `reasoningTokens`, `cacheReporting`, under the identity
`input + cacheRead + cacheWrite === prompt`. The Runner keeps the latest usage
event and attaches it to the *following* `done` (`capturedUsage`); pi-ai and the
Anthropic adapter emit usage before `done`, the shape this expects.

`cacheReporting` is tri-state (`unsupported`, `reported`, `not-reported`); pi-ai
derives it from the cache mode and counters because it normalizes missing cache
fields to `0`, and a zero must not become a fake 0 % hit rate.
`ModelEventUsageUnavailable` is observability only: the OpenAI adapter emits it
when `include_usage` was requested but never answered, and the Runner forwards
it to the `EventSink` without an `AgentInput`.

### Capability query

`describeModel(model)` returns `ResolvedModelInfo`: `model`, `api`, `cache`,
`contextWindow`, `reasoning`, `input`, `inputLimits`. The rules that matter:

- `reasoning` absent means "no control offered"; an off-only list is forbidden
  because naming "off" is byte-identical to naming nothing.
- `input` is tri-state: absent = UNKNOWN (never gated, images still attempted),
  `["text"]` = text-only (gates), `["text","image"]` = vision. Absence is not
  "unavailable"; a gateway that cannot describe its models keeps the image path.
- `inputLimits` is a read-only pi-ai directory fact; Volto never enforces it.
- pi-ai throws for an unknown model code; the gateway treats that as "unknown",
  not a construction failure (`withReasoningCapability`,
  `apps/gateway/src/server.ts`, isolating per provider and per model).

## Provider adapters (pi-ai, OpenAI-compatible, Anthropic)

### pi-ai — the host adapter

`createPiAiModelPort({ providers, defaultProviderId, defaultModel })`
(`packages/providers/pi-ai/src/model-port.ts`) wraps one configured route:
`resolveProviderId` throws at construction when several providers are configured
without `defaultProviderId`, because cross-provider routing builds a port per
dispatch rather than carrying a provider id on the request.

- **`buildModels`** (`collection.ts`) assembles a pi-ai `Models` collection.
  `kind: "catalog"` registers a restricted view of a built-in provider under
  pi-ai's own id (`registryProviderId`); `kind: "custom"` registers a
  hand-declared gateway under the config id. Duplicate registration throws
  rather than silently replacing a provider and its key.
- **Protocol resolution** is data, in order: per-model override → provider
  default → catalog `api` (non-first-class catalog protocols stay untouched) →
  `openai-completions` for custom providers. `auto` exists only in config. An
  unknown protocol throws; an overridden model drops the inherited `compat`,
  because another dialect's flags do not describe this request.
- **Auth.** Catalog providers use `fixedApiKeyAuth` plus a per-request `apiKey`;
  an explicit `auth` plus key synthesizes `authorization`, `x-api-key` or a
  custom header and nulls the other two, so an Anthropic-compatible gateway
  never receives two credentials.
- **Stream.** Unknown model and unsupported effort are rejected before any I/O
  as non-retriable error events. Then `toPiContext` translates the request and
  `models.streamSimple` runs with `signal`, `apiKey`, `reasoning`, `maxTokens`,
  `temperature`, `headers`.
- **`toPiContext`** (`context.ts`) merges system messages into
  `Context.systemPrompt`, validates tool arguments as JSON, maps images (an
  unresolved `ref` throws — the Runner must have resolved it to base64), drops
  tool results whose originating `tool_use` was compacted away, and replays
  assistant blocks through the envelope.
- **Replay envelope** (`replay.ts`): `version: 1` + model id + one block per
  assistant content block carrying `textSignature` / `thinkingSignature` /
  `thoughtSignature` / `redacted`. `readReplayEnvelope` never throws: malformed
  input or a model mismatch returns `undefined`, so a foreign transcript
  degrades to unsigned blocks. `mapAssistantMessage` also compares
  `message.source.modelId`; provider id is deliberately not compared.
- **`describeModel`** publishes `getSupportedThinkingLevels()` minus `off`, the
  model's `input`/`inputLimits`, the protocol `api`, and the cache capability:
  `anthropic-messages` → explicit (1024-token minimum, 4 markers, 20-block
  window, `cache_creation_input_tokens`); the two OpenAI protocols → implicit;
  anything else → none.

### OpenAI-compatible

`createOpenAIModelPort` (`packages/providers/openai/src/model-port.ts`) speaks
Chat Completions directly, appending `/v1` only when the base URL has no version
segment. The body sets `stream: true` and `stream_options.include_usage: true`,
maps tools to `function` entries, maps `maxTokens`/`temperature`, and translates
`responseFormat` into `json_schema` (`strict: true`) or `json_object`. Assistant
tool calls move to message-level `tool_calls`; tool-result images ride in a
follow-up user message labelled with their `tool_call_id`, because the `tool`
role accepts text only. `describeModel` answers only `input`, from `opts.input`
or `openaiFamilyVision`, and ignores `reasoningEffort`, `cacheBreakpoints` and
`layerOrigins`.

### Anthropic

`createAnthropicModelPort` (`packages/providers/anthropic/src/model-port.ts`)
posts to `/v1/messages` with `x-api-key` and `anthropic-version: 2023-06-01`. The
system prompt becomes the top-level `system` field; the tool role becomes a
`user` message of `tool_result` blocks; structured tool-result blocks degrade to
text. `max_tokens` defaults to 4096, and `responseFormat` (no native
equivalent) is appended as a system instruction.

It is the only adapter consuming `cacheBreakpoints`: index 0 puts
`cache_control: ephemeral` on the system block, and message breakpoints apply at
`index - systemCount` because system messages were extracted. `reasoning` blocks
are dropped on replay — this adapter does not read `modelMeta`, and Anthropic
needs the per-block signature. `reasoningEffort` is ignored, and `describeModel`
answers only `input`.

## Reasoning effort and model routing tiers

### Reasoning effort

An effort is an adapter-owned opaque id (`ReasoningEffortId`, a branded string).
Core carries it verbatim: no enum, no aliasing, no clamping, no "nearest
supported" coercion. Absence means "send no reasoning option", preserving the
provider default. Two gates exist, and they are not redundant:

1. `assertSupportedReasoningEffort` (`apps/gateway/src/sessions.ts`) runs in
   `resolveConfig` before any rebuild, for the turn-level `POST /messages`
   effort; an unsupported value fails the request and is never rewritten.
2. `createPiAiModelPort.stream` re-checks immediately before provider I/O and
   yields a non-retriable error event.

Sub-agent efforts are gated only by (2). Precedence is definition → tier →
parent (`resolvedSubReasoningEffort`), and the tier value rides on the *resolved*
tier only, so a degraded dispatch inherits the parent's effort instead of a
value its model may reject.

### Routing tiers

A tier is a named intent, `{ id, label, description, target, reasoningEffort? }`,
where `target` is `{ providerId, modelId }` or `null` for unassigned
(`apps/gateway/src/config/routing-tiers.ts`). The table lives in
`~/.volto/config.json` under `routingTiers`; before the first write `list()`
serves the unpersisted `premium`/`fast`/`economy` template with all targets
`null`, and a present section is returned verbatim, including `[]`.
`PUT /config/routing-tiers` replaces the whole array, validates ids (non-empty,
unique, not reserved `__inherit__`), resolves assigned targets through
`providerStore.resolveModel`, and answers `409` for a removed id still referenced
by an agent definition (`collectTierReferences`; plugin references only warn).

The SDK sees pure data plus a callback, never a provider import:

- `CreateAgentOptions.routingTiers` + `resolveSubagentModelPort`. `routingTiers
  !== undefined` switches every dispatch into tier mode, so a host with an empty
  table must omit the key rather than pass `[]`, or legacy raw model codes become
  unknown tier ids.
- Resolution happens in the dispatch closure (`packages/sdk/src/create-agent.ts`,
  "Model routing tier resolution"), with two audiences. A per-dispatch `model`
  naming an unknown or unassigned tier throws — the task tool turns it into an
  `isError` result with the assignable ids, before any provider I/O exists. A
  definition `model:` naming an unknown, unassigned or unresolvable tier degrades
  to the parent model and emits `subagent_model_tier_unresolved` (projected onto
  the dispatch card in `packages/core/src/view-projection.ts`).
- A resolved tier replaces the child's `ModelPort`, stamps its `providerId` onto
  `assistant_message.source`, and contributes `visionSupported` and
  `contextWindow`, so image gating and compaction sizing follow the tier model.
- The host factory is `buildSubagentModelPortFactory`
  (`apps/gateway/src/sessions.ts`): `resolveModel` → `buildProviderConfig` →
  `createPiAiModelPort`, then `describeModel` for capability facts; a stored
  declaration beats the described value, unknown facts are omitted, and `null`
  means unresolvable (degrade path). It also materializes the optional
  session-title model from `preferences.titleProviderId` / `titleModelId`.

`packages/sdk/src/model-router.ts` (`createModelRouter`) is a different,
currently unwired mechanism: it wraps a primary port plus ordered fallbacks,
buffers events, and retries a retriable error on the next provider. No host
constructs one, and it does not forward `describeModel`.

## Invariants and boundaries

- **Dependency direction.** `core ← providers ← sdk ← apps`. Provider packages
  `import type` from core only; `@volto/core` has zero dependencies and no I/O.
- **No provider identity on the request.** One `ModelRequest` describes
  messages, tools and sampling; a different provider is a different port. The
  replay guard therefore compares only `source.modelId` — a wrapper that swaps
  providers per call (such as `createModelRouter`) can replay a signature into a
  provider that never issued it.
- **Errors do not cross the port as exceptions.** They arrive as events; the
  reducer decides retry versus turn end, and the tool loop stays alive.
- **One terminal event; tool starts carry id and name.** A stream that stops
  without one yields a truncated-response error, and a nameless `tool_use_start`
  is dropped because the core has no nameless tool call.
- **Usage is never invented.** `cacheReporting` separates "not reported" from
  "zero"; `usage_unavailable` flags a silent provider degradation without
  changing any meter.
- **Capability absence means unknown, not unavailable.** Only an explicit
  text-only `input` gates images; only an explicit `reasoning` list offers
  efforts.
- **Protocol is a route attribute.** Resolved per provider/model
  (`resolveProviderProtocol`), recorded in `chatMeta.protocol`, and part of the
  rebuild gate (`sameConfig`), so changing it swaps the agent, not a mid-turn
  request.
- **Credentials never travel as data.** Keys are encrypted at rest (`apiKeyEnc`),
  masked on every public response, and `resolveModel` — the one method returning
  plaintext — is server-side only. Custom `headers` are non-secret by contract;
  the key is injected through `auth`.
- **`cacheBreakpoints` are advisory.** Core always computes them; only the
  standalone Anthropic adapter places native markers, and pi-ai relies on each
  protocol's own prompt caching.

## Decisions and rejected alternatives (with dates)

- **2026-07-24 — provider/model CRUD instead of global model fields.** The
  desktop app moved from three global settings to a provider list with models,
  bound per session, with no migration because there were no external users.
  Storage has since moved from the Electron store into the gateway's unified
  `~/.volto/config.json` (`providers` section) — the reversal.
- **2026-09-08 — adapter-owned, opaque reasoning efforts.** Rejected a core enum
  (efforts belong to an exact model; `xhigh`/`max` are opt-in), rejected mapping
  unsupported efforts to the nearest one (silently changing the recorded
  request), rejected text-only reasoning without a replay envelope (signed
  thinking blocks fail on the second tool-loop step), and rejected a second
  OpenAI-only runtime. Reversal: the spec published pi-ai's levels *including*
  `off`; the adapter now filters `off` out, since an off-only list equals no list.
- **2026-09-23 — `input` replaces `vision`.** One tri-state field drives UI, wire
  behaviour, server gating and the composer; `inputLimits` stays a read-only
  directory fact, since an override would not change pi-ai's compression.
- **2026-10-29 — routing tiers instead of raw model codes.** `AgentSpec.model`
  and the task tool's `model` now mean tier ids; rejected automatic main-model
  routing, rejected silent model substitution, and chose per-dispatch
  `ModelPort` injection so no core contract changed. The v2 revision added
  `null` targets and per-tier `reasoningEffort`. Two reversals: the design said
  tier menus must not be rendered into the tool description, yet the task tool
  now renders assignable tiers and puts every id in the schema enum; and the
  optional `list_model_tiers` tool was never built.
- **2026-11-09 — three first-class protocols behind one adapter.** `auto` in
  config resolves to one concrete protocol; protocol/auth/cache are data, not
  provider-name branches; the HTTP client is never rewritten. Rejected global
  protocol switches and mid-turn switching. Two reversals: the shipped probe is
  a config/capability probe (`live: false`, no network), not the live wire probe
  the spec described; and the pi-ai adapter ignores `cacheBreakpoints` entirely,
  leaving native markers to the standalone Anthropic adapter.

## How to change it (tests to run, regression points)

Static gate per affected package (never the whole repo by default, never
`@voltojs/desktop-app`):

```bash
pnpm turbo run typecheck lint test --filter @voltojs/provider-pi-ai
pnpm turbo run typecheck lint test --filter @voltojs/provider-openai
pnpm turbo run typecheck lint test --filter @voltojs/provider-anthropic
pnpm turbo run typecheck lint test --filter @voltojs/sdk
pnpm turbo run typecheck lint test --filter @voltojs/gateway
node scripts/check-core-zero-deps.mjs
```

A change to `ModelPort`, `ModelEvent`, `TokenUsage` or `ResolvedModelInfo` is a
cross-package contract change: add the core gate and `@voltojs/runtimes-node`,
and rebuild upstream `dist` before testing downstream packages.

Regression points, by change:

- **New `ModelEvent` variant or field** — `modelEventToInputs` needs a branch; an
  unrouted variant is silently dropped. Add a core replay test: the same
  `AgentInput` sequence must produce the same `(state, effects)`.
- **Adapter behaviour** — provider tests use `fauxProvider()` / scripted streams,
  never real keys: `packages/providers/pi-ai/src/__tests__/{stream-normalize,
  tool-loop, replay, catalog, collection, model-port}.test.ts` plus the OpenAI and
  Anthropic suites; `replay-equivalence.test.ts` pins both legacy adapters to the
  same neutral event stream.
- **Effort handling** — keep the three shapes distinct: gateway pre-check throws,
  pi-ai pre-I/O error event, and no silent omission of a requested effort.
- **Tier dispatch** — `packages/sdk/src/__tests__/subagent-tier-routing.test.ts`
  and the gateway server tests cover the two audiences, the `[]`-vs-omitted
  table case, and the 409 reference scan.
- **Capability metadata** — `describeModelInfo` must keep the `off`-free effort
  list, the tri-state `input`, and `inputLimits` absent for custom/synthesized
  models; `GET /providers` merges exactly these into the settings response.
- **Protocol/auth** — the pi-ai boundary tests pin that a bearer route
  suppresses `x-api-key`, an `x-api-key` route suppresses `authorization`, and
  no credentials are read from the environment.

## Further reading (archive links)

- Specs: ``2026-07-24``
  (provider/model CRUD), ``2026-09-08``
  (opaque efforts, replay envelope, pi-ai runtime), ``2026-09-23``
  (tri-state input), ``2026-10-29``
  (routing tiers), ``2026-11-09``
  (three protocols, cacheReporting).
- Plans: ``core contract``,
  ``pi-ai port``,
  ``input fields``,
  ``routing tiers``,
  ``three protocols``.
- User-facing counterpart: `docs/user/using/guides/models-and-providers.md`.