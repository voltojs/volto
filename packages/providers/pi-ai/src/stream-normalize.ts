import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ModelEvent } from "@volto/core";
import { toReplayEnvelope } from "./replay.js";

/**
 * Normalize pi-ai's AssistantMessageEvent stream into volto's neutral
 * ModelEvent stream.
 *
 * pi-ai never throws out of the stream itself; failures arrive as an
 * `{ type: "error" }` event carrying the failed AssistantMessage. This
 * generator preserves that property end to end: it never throws, it only
 * ever yields ModelEvents (including a `{ type: "error" }` one).
 */
export async function* normalizeStream(
  events: AsyncIterable<AssistantMessageEvent>,
  model: string,
): AsyncIterable<ModelEvent> {
  for await (const event of events) {
    switch (event.type) {
      case "text_delta":
        yield { type: "text_delta", text: event.delta };
        break;

      case "thinking_delta":
        yield { type: "reasoning_delta", text: event.delta };
        break;

      case "toolcall_start": {
        // toolcall_start itself carries no name, only contentIndex — the
        // name lives on the matching block of `partial.content` (see
        // api-notes.md item 5 / task-4 brief). Without it, core's reducer
        // treats the following tool_use_delta chunks as argument fragments
        // for an already-open call rather than the start of a new one
        // (it gates "new tool call" on toolCallId + toolCallName both being
        // truthy), so a missing name here would silently swallow the call.
        const block = event.partial.content[event.contentIndex];
        if (block?.type !== "toolCall") {
          // Malformed/unexpected pi-ai stream shape: no toolCall block at
          // this index. Nothing sane to emit — skip rather than yielding a
          // nameless tool_use_start that core would misinterpret.
          break;
        }
        yield { type: "tool_use_start", toolCallId: block.id, toolName: block.name };
        break;
      }

      case "toolcall_delta": {
        const block = event.partial.content[event.contentIndex];
        if (block?.type !== "toolCall") {
          break;
        }
        yield {
          type: "tool_use_delta",
          toolCallId: block.id,
          argumentsDelta: event.delta,
        };
        break;
      }

      case "done": {
        const usage = event.message.usage;
        if (usage) {
          yield {
            type: "usage",
            inputTokens: usage.input,
            outputTokens: usage.output,
            totalTokens: usage.totalTokens,
            cacheReadTokens: usage.cacheRead,
            cacheWriteTokens: usage.cacheWrite,
            // A provider that reports no cache buckets at all is "not
            // reported", not a cache hit rate of zero. Presence of either
            // bucket is the strongest signal pi-ai exposes.
            cacheReporting:
              usage.cacheRead !== undefined || usage.cacheWrite !== undefined
                ? "reported"
                : "not-reported",
            ...(usage.reasoning !== undefined ? { reasoningTokens: usage.reasoning } : {}),
          };
        }
        yield {
          type: "done",
          stopReason: mapStopReason(event.reason),
          meta: toReplayEnvelope(event.message, model),
        };
        break;
      }

      case "error": {
        // `event.error` is a full AssistantMessage, not a string/Error — the
        // human-readable text lives at event.error.errorMessage (api-notes.md
        // item 5 / trap #1). An abort is never retriable. For a plain
        // "error" reason, pi-ai gives us nothing beyond a free-text message —
        // no status code, no error class — so there is no reliable signal to
        // decide retriability from. Default to false: spinning retries
        // against a permanently failing endpoint is worse than not retrying
        // a transient one.
        yield {
          type: "error",
          error: event.error.errorMessage ?? `pi-ai stream ${event.reason}`,
          retriable: false,
        };
        break;
      }

      // "start"/"text_start"/"text_end"/"thinking_start"/"thinking_end"/
      // "toolcall_end" carry no information volto's ModelEvent needs beyond
      // what the deltas and the final `done` message already provide.
      default:
        break;
    }
  }
}

function mapStopReason(
  reason: Extract<AssistantMessageEvent, { type: "done" }>["reason"],
): "end_turn" | "tool_use" | "max_tokens" {
  switch (reason) {
    case "toolUse":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
    case "deferred":
      return "end_turn";
  }
}
