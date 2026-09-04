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

import type { ModelEvent } from "@volto/core";

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
): AsyncGenerator<ModelEvent> {
  const toolCalls = new Map<number, ToolCallEntry>();
  /** Buffer argument deltas for tool call indices that haven't received id/name yet. */
  const pendingArgs = new Map<number, string>();
  let hasEmittedUsage = false;

  for await (const chunk of rawChunks) {
    // Usage may arrive in the final chunk (stream_options.include_usage)
    if (chunk.usage && !hasEmittedUsage) {
      hasEmittedUsage = true;
      yield {
        type: "usage",
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? undefined,
        totalTokens: chunk.usage.total_tokens ?? undefined,
        reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? undefined,
      };
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

    // finish_reason
    if (finish_reason) {
      const stopReason = mapFinishReason(finish_reason);
      yield { type: "done", stopReason };
    }
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
