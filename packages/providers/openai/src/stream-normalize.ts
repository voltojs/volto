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

import type { ModelEvent } from "@agent-core/core";

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
  } | null;
}

/**
 * Normalize a stream of raw OpenAI chunks into core ModelEvents.
 * Statefully accumulates tool call arguments across chunks.
 */
export async function* normalizeStream(
  rawChunks: AsyncIterable<RawStreamChunk>,
): AsyncGenerator<ModelEvent> {
  const toolCalls = new Map<number, { id: string; name: string; argsAccum: string; emittedStart: boolean }>();
  let hasEmittedUsage = false;

  for await (const chunk of rawChunks) {
    // Usage may arrive in the final chunk (stream_options.include_usage)
    if (chunk.usage && !hasEmittedUsage) {
      hasEmittedUsage = true;
      yield {
        type: "usage",
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
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

        if (tc.id && tc.function?.name && !existing) {
          // New tool call starting
          const entry = {
            id: tc.id,
            name: tc.function.name,
            argsAccum: tc.function.arguments ?? "",
            emittedStart: true,
          };
          toolCalls.set(tc.index, entry);
          yield {
            type: "tool_use_start",
            toolCallId: entry.id,
            toolName: entry.name,
          };
          // First chunk may also carry arguments
          if (tc.function.arguments) {
            yield {
              type: "tool_use_delta",
              toolCallId: entry.id,
              argumentsDelta: tc.function.arguments,
            };
          }
        } else if (existing) {
          // Arguments delta for existing tool call
          const delta = tc.function?.arguments ?? "";
          if (delta) {
            existing.argsAccum += delta;
            yield {
              type: "tool_use_delta",
              toolCallId: existing.id,
              argumentsDelta: delta,
            };
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
