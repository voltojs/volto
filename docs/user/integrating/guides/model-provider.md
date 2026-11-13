---
title: Model connection (ModelPort)
type: guide
source:
  - packages/core/src/ports.ts
  - packages/providers/openai/src/model-port.ts
  - packages/providers/anthropic/src/model-port.ts
  - packages/providers/pi-ai/src/model-port.ts
generated: false
verified: 2026-11-11
---

# Model connection (ModelPort)

> After reading this you will: be able to implement a model connection yourself, or judge whether an existing adapter is enough.

## The contract has a single method

```text
interface ModelPort {
  stream(req: ModelRequest): AsyncIterable<ModelEvent>;
  describeModel?(model: string): Promise<ResolvedModelInfo>;
}
```

- `stream` must **emit as it receives**: one call returns an async iterator and events come out in arrival order. Buffering the whole result and returning it also runs, but the UI loses character-by-character rendering.
- `describeModel` is optional. Not implementing it means declaring no capabilities: no reasoning effort, no context window, and image input is treated as "unknown" (still allowed, not hidden).

## What a request contains

| Field | Notes |
| --- | --- |
| `messages` | Conversation history (including tool calls and tool results) |
| `tools` | Tool definitions available to the model (JSON Schema) |
| `model` | Model identifier; when omitted, the adapter picks the default |
| `maxTokens` / `temperature` | Sampling limits |
| `reasoningEffort` | Reasoning effort id; **the adapter declares the values**, the kernel forwards it verbatim |
| `abortSignal` | Cancellation signal; the adapter should stop and end the stream as soon as possible |
| `responseFormat` | Structured output request (`{ type: "json", schema? }`) |
| `cacheBreakpoints` | Indices of the anchor messages for prompt caching; the adapter translates them into the vendor's mechanism |
| `layerOrigins` | Origin map of context layers, used for cache layering |

## Which events to emit

| Event | When |
| --- | --- |
| `text_delta` | Body text delta |
| `reasoning_delta` | Reasoning / thinking delta |
| `tool_use_start` / `tool_use_delta` | The model wants to call a tool: id and name first, then argument deltas |
| `usage` | Token usage (input / output / cache) |
| `done` | This call ended, with `stopReason` |
| `error` | The call failed, with `error` and `retriable?` |
| `usage_unavailable` | Usage was requested but the vendor did not provide it — an observability hint only, it does not affect the flow |

`done.stopReason` has three values: `end_turn` (finished speaking), `tool_use` (wants to call a tool), `max_tokens` (truncated). **Getting this word wrong derails the loop**: if you say `end_turn` but provide no end signal, the model gets asked again and again.

## Do not throw errors at the kernel

When `stream` hits an error internally, the correct move is to **emit an `error` event and end the stream**, not to `throw`. The kernel normalizes the error into a model-error input and feeds it back, giving the loop a chance to recover (switch models, retry, or tell the user directly). Throwing an exception blows up the turn.

`retriable: true` means a retry is worth it (rate limit, timeout); `false` means a retry will not help (authentication failure, model not found).

## Ready-made adapters

| Package | Purpose |
| --- | --- |
| `@voltojs/provider-pi-ai` | The default. Wires the built-in provider catalog, or declares a custom OpenAI-compatible endpoint |
| `@voltojs/provider-openai` | Talks directly to an OpenAI-compatible API |
| `@voltojs/provider-anthropic` | Talks directly to the Anthropic Messages API |

All three implement streaming parsing, incremental tool-call accumulation and usage normalization. **The two things most easily gotten wrong when writing your own adapter**: tool-call arguments arrive as incremental chunks (accumulate them by id), and the vendor's finish reason must be mapped onto the three values above.

## Capability declarations decide which features appear

The capabilities returned by `describeModel` change the wiring:

- `reasoning` has a value → only then does the model offer selectable reasoning effort (without the declaration all that remains is "do not send").
- `input` explicitly excludes `"image"` → tools that depend on images are removed; when unknown, nothing is removed (a 400 from the vendor is preferable to a tool vanishing for no reason).
- `cache` declared → the adapter places cache breakpoints per the declared mechanism.
- `contextWindow` → the basis for context usage and compaction timing.

## When something goes wrong

- **The UI does not render one character at a time** → the adapter buffers the whole segment and emits it at the end; check that it really `yield`s chunk by chunk.
- **Tool-call arguments always fail to parse** → chunks are not accumulated by `toolCallId`, or chunks from several tools are mixed together.
- **The model never wraps up** → `stopReason` is mapped wrong.
- **The reasoning effort selector is gone** → `describeModel` is not implemented or does not return `reasoning`.