/**
 * stream-normalize — converts raw OpenAI streaming chunks into core ModelEvents.
 *
 * Handles:
 * - Text delta accumulation
 * - Reasoning delta (field names vary: reasoning_content / reasoning / thinking)
 * - Tool call incremental streaming (start + delta by index, arguments concatenation)
 * - Usage (prompt_tokens + completion_tokens)
 * - finish_reason → stopReason mapping
 */

import type { ModelEvent } from "@voltojs/core";

/** Raw chunk shape from OpenAI-compatible /v1/chat/completions stream */
interface RawChoiceDelta {
  delta: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    thinking?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: string;
      function: {
        name?: string;
        arguments: string;
      };
    }>;
  };
  finish_reason: string | null;
}

export interface RawStreamChunk {
  choices?: RawChoiceDelta[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    /** DeepSeek's hit/miss split: the same cache signal as prompt_tokens_details.cached_tokens, spelled differently. */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    /** Present for reasoning models (o-series etc.); reasoning_tokens bills separately from completion_tokens. */
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  } | null;
}

interface ToolCallEntry {
  id: string;
  name: string;
  argsAccum: string;
  emittedStart: boolean;
}

export interface NormalizeStreamOptions {
  /**
   * Whether the request asked the provider for usage (e.g. via
   * `stream_options.include_usage`). When true and the stream completes
   * without ever yielding a usage chunk, `normalizeStream` emits a single
   * `usage_unavailable` event so downstream consumers (context meter, cost
   * meter) can distinguish "this provider never reports usage" from "usage
   * for this particular turn just hasn't arrived yet".
   */
  includeUsageRequested?: boolean;
}

/**
 * Normalize a stream of raw OpenAI chunks into core ModelEvents.
 * Statefully accumulates tool call arguments across chunks.
 *
 * Some OpenAI-compatible providers (Azure, vLLM, etc.) send the initial
 * tool call chunk without `id` or `name` — those arrive in a later delta.
 * We buffer argument-only chunks and merge them once the identity arrives.
 */
export async function* normalizeStream(
  rawChunks: AsyncIterable<RawStreamChunk>,
  options: NormalizeStreamOptions = {},
): AsyncGenerator<ModelEvent> {
  const toolCalls = new Map<number, ToolCallEntry>();
  /** Buffer argument deltas for tool call indices that haven't received id/name yet. */
  const pendingArgs = new Map<number, string>();
  let hasEmittedUsage = false;
  /**
   * Terminal event held back until a requested usage chunk lands. OpenAI
   * sends usage in a final chunk AFTER the chunk carrying `finish_reason`
   * (`stream_options.include_usage`), so emitting `done` immediately would
   * strand that usage behind the terminal event — and consumers such as the
   * Runner's `lastUsage` (reset on `done`) drop it, losing the turn's token
   * record. Usage is therefore always emitted before `done`.
   */
  let pendingStopReason: "end_turn" | "tool_use" | "max_tokens" | undefined;
  let bufferedUsage: Extract<ModelEvent, { type: "usage" }> | undefined;

  /** Buffered usage first, then the terminal event — the order consumers rely on. */
  const flushTerminal = (): ModelEvent[] => {
    const out: ModelEvent[] = [];
    if (bufferedUsage !== undefined) {
      out.push(bufferedUsage);
      bufferedUsage = undefined;
    }
    if (pendingStopReason !== undefined) {
      out.push({ type: "done", stopReason: pendingStopReason });
      pendingStopReason = undefined;
    }
    return out;
  };

  for await (const chunk of rawChunks) {
    // Usage may arrive in the final chunk — either together with
    // finish_reason or, as OpenAI sends it, in a trailing choices-less chunk.
    if (chunk.usage && !hasEmittedUsage) {
      hasEmittedUsage = true;
      const promptTokens = chunk.usage.prompt_tokens ?? 0;
      // Two vendor spellings of the same split. DeepSeek reports hit/miss
      // directly; OpenAI reports the cached slice inside prompt_tokens_details
      // while prompt_tokens stays the full prompt.
      const hit = chunk.usage.prompt_cache_hit_tokens;
      const miss = chunk.usage.prompt_cache_miss_tokens;
      const cachedDetail = chunk.usage.prompt_tokens_details?.cached_tokens;
      // prompt_tokens is the authority: a hostile/inconsistent payload that
      // sends prompt_cache_miss_tokens without prompt_cache_hit_tokens must
      // still derive cachedTokens from it, otherwise cacheReadTokens ends up
      // undefined while inputTokens (= miss) silently underreports the real
      // prompt size, breaking the input + cacheRead + cacheWrite === prompt
      // identity downstream.
      const cachedTokens =
        hit ?? cachedDetail ?? (miss !== undefined ? Math.max(0, promptTokens - miss) : undefined);
      const uncached = Math.max(0, promptTokens - (cachedTokens ?? 0));
      bufferedUsage = {
        type: "usage",
        // inputTokens is the UNCACHED prompt across all providers (Anthropic's
        // input_tokens already has this shape); cached tokens ride in
        // cacheReadTokens, so input + cacheRead + cacheWrite is the full
        // prompt. Reporting prompt_tokens verbatim here made CostMeter price
        // the cached portion twice.
        inputTokens: uncached,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        cacheReadTokens: cachedTokens,
        totalTokens: chunk.usage.total_tokens ?? undefined,
        reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? undefined,
      };
      // A trailing usage chunk after finish_reason is the usual shape: the
      // terminal event was waiting for it, so both can go out now.
      if (pendingStopReason !== undefined) {
        for (const event of flushTerminal()) yield event;
      }
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const { delta, finish_reason } = choice;

    // Text content
    if (delta.content) {
      yield { type: "text_delta", text: delta.content };
    }

    // Reasoning — try multiple field names for compatibility
    const reasoningText = delta.reasoning_content ?? delta.reasoning ?? delta.thinking ?? null;
    if (reasoningText) {
      yield { type: "reasoning_delta", text: reasoningText };
    }

    // Tool calls — incremental streaming by index
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const existing = toolCalls.get(tc.index);
        const hasIdentity = Boolean(tc.id && tc.function?.name);

        if (hasIdentity && !existing) {
          // New tool call — may have buffered argument-only chunks from earlier.
          const buffered = pendingArgs.get(tc.index) ?? "";
          const entry: ToolCallEntry = {
            id: tc.id!,
            name: tc.function!.name!,
            argsAccum: buffered + (tc.function?.arguments ?? ""),
            emittedStart: true,
          };
          toolCalls.set(tc.index, entry);
          pendingArgs.delete(tc.index);
          yield {
            type: "tool_use_start",
            toolCallId: entry.id,
            toolName: entry.name,
          };
          // Emit any buffered args first, then current chunk's args.
          if (entry.argsAccum) {
            yield {
              type: "tool_use_delta",
              toolCallId: entry.id,
              argumentsDelta: entry.argsAccum,
            };
          }
        } else if (existing) {
          // Arguments delta for existing tool call.
          const argsDelta = tc.function?.arguments ?? "";
          if (argsDelta) {
            existing.argsAccum += argsDelta;
            yield {
              type: "tool_use_delta",
              toolCallId: existing.id,
              argumentsDelta: argsDelta,
            };
          }
        } else if (!hasIdentity) {
          // Argument-only chunk before identity arrives — buffer it.
          const argsDelta = tc.function?.arguments ?? "";
          if (argsDelta) {
            pendingArgs.set(tc.index, (pendingArgs.get(tc.index) ?? "") + argsDelta);
          }
        }
      }
    }

    // finish_reason: hold the terminal event when a usage chunk was requested
    // but has not landed yet (see pendingStopReason above).
    if (finish_reason) {
      pendingStopReason = mapFinishReason(finish_reason);
      if (bufferedUsage !== undefined || !options.includeUsageRequested) {
        for (const event of flushTerminal()) yield event;
      }
    }
  }

  // Flush whatever is still buffered: a stream that ends right after
  // finish_reason without a usage chunk, or usage that arrived on a stream
  // that was cut before any terminal event.
  for (const event of flushTerminal()) yield event;

  // The stream ended without ever yielding a usage chunk, despite the
  // request having asked for one — a silent provider degradation. Fire at
  // most once per stream.
  if (options.includeUsageRequested && !hasEmittedUsage) {
    yield { type: "usage_unavailable" };
  }
}

function mapFinishReason(reason: string): "end_turn" | "tool_use" | "max_tokens" {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "end_turn";
  }
}
