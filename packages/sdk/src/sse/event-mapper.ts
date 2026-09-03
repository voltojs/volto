/**
 * Event mapper — translates internal runner/reducer events into the
 * wire-level SSE protocol defined in `./types.ts`.
 *
 * Hosts (headless-server, desktop, future mobile gateways) share this mapper so
 * every transport speaks the same protocol. The mapper is stateful only in the
 * ways the protocol requires: it accumulates streamed text so each `token`
 * message carries both the incremental `delta` and the `content` so far, and it
 * owns the monotonic event id used for Last-Event-ID recovery.
 */

import {
  SSEEventType,
  type SSEMessage,
  type TokenData,
  type ToolCallData,
  type ToolResultData,
  type ErrorData,
  type StateChangeData,
} from "./types.js";

/** Internal event shape emitted through `EventSink`. */
export interface InternalEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface EventMapperOptions {
  /** Starting value for the event id counter. @default 0 */
  startId?: number;
  /** Clock used for message timestamps. @default Date.now */
  now?: () => number;
}

/**
 * Internal event types that carry no meaning for a chat client and would only
 * add noise to the wire. `tool_use_delta` is dropped because a `tool_call`
 * message must carry complete arguments — those only exist once the reducer
 * emits `tool_use_complete`.
 */
const IGNORED_EVENTS = new Set(["tool_use_delta", "user_message"]);

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Create a stateful mapper that converts internal events to `SSEMessage`s.
 *
 * Returns `null` for events that must not reach the client.
 */
export function createEventMapper(options: EventMapperOptions = {}) {
  const { startId = 0, now = Date.now } = options;

  let eventId = startId;
  let accumulatedText = "";

  function envelope<T>(event: SSEEventType, data: T): SSEMessage<T> {
    return { id: String(++eventId), event, data, timestamp: now() };
  }

  /** Map one internal event. `null` means "drop this event". */
  function map(event: InternalEvent): SSEMessage | null {
    if (IGNORED_EVENTS.has(event.type)) return null;

    switch (event.type) {
      case "text_delta": {
        const delta = asString(event.data["text"]);
        if (!delta) return null;
        accumulatedText += delta;
        return envelope<TokenData>(SSEEventType.TOKEN, {
          content: accumulatedText,
          delta,
        });
      }

      case "tool_use_complete":
        return envelope<ToolCallData>(SSEEventType.TOOL_CALL, {
          id: asString(event.data["toolCallId"]),
          name: asString(event.data["toolName"]),
          args: (event.data["input"] as Record<string, unknown>) ?? {},
        });

      case "tool_result":
        return envelope<ToolResultData>(SSEEventType.TOOL_RESULT, {
          id: asString(event.data["toolCallId"]),
          result: {
            toolName: event.data["toolName"],
            durationMs: event.data["durationMs"],
          },
          isError: event.data["isError"] === true,
        });

      case "error":
        return envelope<ErrorData>(SSEEventType.ERROR, {
          code: "AGENT_ERROR",
          message: asString(event.data["error"], "Unknown agent error"),
          retryable: event.data["retriable"] === true,
        });

      case "budget_exceeded":
        return envelope<ErrorData>(SSEEventType.ERROR, {
          code: "BUDGET_EXCEEDED",
          message: asString(event.data["reason"], "Budget exceeded"),
          retryable: false,
        });

      case "cancelled":
        return envelope<ErrorData>(SSEEventType.ERROR, {
          code: "CANCELLED",
          message: asString(event.data["reason"], "Run cancelled"),
          retryable: false,
        });

      default:
        // Everything else (model_done, reasoning_delta, steering_queued,
        // self_correct, done, ...) is surfaced as a state change so clients can
        // render progress without the protocol needing a case per event.
        return envelope<StateChangeData & { detail: Record<string, unknown> }>(
          SSEEventType.STATE_CHANGE,
          { state: event.type, previous: "", detail: event.data },
        );
    }
  }

  /** Build the terminal `done` message for the current run. */
  function done(): SSEMessage<{ content: string }> {
    return envelope(SSEEventType.DONE, { content: accumulatedText });
  }

  /** Build an `error` message for a transport/runtime failure. */
  function error(message: string, code = "STREAM_ERROR", retryable = false): SSEMessage<ErrorData> {
    return envelope<ErrorData>(SSEEventType.ERROR, { code, message, retryable });
  }

  /** Build a `heartbeat` keep-alive message. */
  function heartbeat(): SSEMessage<{ timestamp: number }> {
    return envelope(SSEEventType.HEARTBEAT, { timestamp: now() });
  }

  /** Reset the accumulated text so the next run starts a fresh message. */
  function resetTurn(): void {
    accumulatedText = "";
  }

  /** Text accumulated for the current turn. */
  function getAccumulatedText(): string {
    return accumulatedText;
  }

  return { map, done, error, heartbeat, resetTurn, getAccumulatedText };
}

/** Serialize an `SSEMessage` into the SSE wire format. */
export function formatSSEFrame(message: SSEMessage): string {
  return `id: ${message.id}\nevent: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`;
}
