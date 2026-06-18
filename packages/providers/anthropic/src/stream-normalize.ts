/**
 * stream-normalize — converts raw Anthropic streaming events into core ModelEvents.
 *
 * Handles:
 * - message_start → captures input_tokens (cache read/write)
 * - content_block_start (text / thinking / tool_use / server_tool_use)
 * - content_block_delta (text_delta, thinking_delta, input_json_delta, signature_delta)
 * - message_delta → output_tokens (cumulative) + stop_reason → done + usage event
 * - message_stop → stream complete
 * - ping → skip
 * - error → error event with retriable flag
 */

import type { ModelEvent } from "@volto/core";

/** Raw SSE event parsed from Anthropic Messages API stream */
export interface RawAnthropicEvent {
  type: string;
  [key: string]: unknown;
}

/** Accumulated state for a tool_use content block */
interface ToolUseBlock {
  toolCallId: string;
  toolName: string;
}

/**
 * Normalize a stream of raw Anthropic events into core ModelEvents.
 *
 * Stateful: tracks content_block type by index to route deltas correctly.
 * Usage is emitted as a single event: input tokens from message_start,
 * output tokens from message_delta (which carries the final cumulative count).
 */
export async function* normalizeStream(
  rawEvents: AsyncIterable<RawAnthropicEvent>,
): AsyncGenerator<ModelEvent> {
  /** Map content_block index → block type */
  const blockTypes = new Map<number, "text" | "thinking" | "tool_use" | "server_tool_use">();
  /** Map content_block index → tool_use metadata */
  const toolUseBlocks = new Map<number, ToolUseBlock>();

  /** Captured from message_start for final usage event */
  let inputTokens = 0;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;

  for await (const event of rawEvents) {
    switch (event.type) {
      case "message_start": {
        const msg = event.message as { usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } } | undefined;
        const usage = msg?.usage;
        if (usage) {
          inputTokens = usage.input_tokens ?? 0;
          cacheReadTokens = usage.cache_read_input_tokens ?? undefined;
          cacheWriteTokens = usage.cache_creation_input_tokens ?? undefined;
        }
        break;
      }

      case "content_block_start": {
        const index = event.index as number;
        const block = event.content_block as { type?: string; id?: string; name?: string } | undefined;
        const blockType = block?.type;

        if (blockType === "text") {
          blockTypes.set(index, "text");
        } else if (blockType === "thinking") {
          blockTypes.set(index, "thinking");
        } else if (blockType === "tool_use" || blockType === "server_tool_use") {
          blockTypes.set(index, blockType);
          const entry: ToolUseBlock = {
            toolCallId: block?.id ?? "",
            toolName: block?.name ?? "",
          };
          toolUseBlocks.set(index, entry);
          yield {
            type: "tool_use_start",
            toolCallId: entry.toolCallId,
            toolName: entry.toolName,
          };
        }
        break;
      }

      case "content_block_delta": {
        const index = event.index as number;
        const delta = event.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined;

        if (delta?.type === "text_delta" && delta.text) {
          yield { type: "text_delta", text: delta.text };
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          yield { type: "reasoning_delta", text: delta.thinking };
        } else if (delta?.type === "input_json_delta" && delta.partial_json != null) {
          const toolEntry = toolUseBlocks.get(index);
          if (toolEntry) {
            yield {
              type: "tool_use_delta",
              toolCallId: toolEntry.toolCallId,
              argumentsDelta: delta.partial_json,
            };
          }
        }
        // signature_delta → skip
        break;
      }

      case "content_block_stop": {
        const index = event.index as number;
        blockTypes.delete(index);
        toolUseBlocks.delete(index);
        break;
      }

      case "message_delta": {
        const delta = event.delta as { stop_reason?: string } | undefined;
        const usage = event.usage as { output_tokens?: number } | undefined;
        const outputTokens = usage?.output_tokens ?? 0;

        yield {
          type: "usage",
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheReadTokens ?? undefined,
          cacheWriteTokens: cacheWriteTokens ?? undefined,
        };

        if (delta?.stop_reason) {
          yield { type: "done", stopReason: mapStopReason(delta.stop_reason) };
        }
        break;
      }

      case "message_stop":
        break;

      case "ping":
        break;

      case "error": {
        const errData = event.error as { type?: string; message?: string } | undefined;
        const errMsg = errData?.message ?? errData?.type ?? "Unknown Anthropic error";
        const isOverloaded = errData?.type === "overloaded_error";
        yield {
          type: "error",
          error: `Anthropic API error: ${errMsg}`,
          retriable: isOverloaded,
        };
        break;
      }
    }
  }
}

function mapStopReason(reason: string): "end_turn" | "tool_use" | "max_tokens" {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "end_turn";
  }
}
