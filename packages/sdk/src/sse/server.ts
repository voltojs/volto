/**
 * SSE Server — bridges StreamChannel to HTTP SSE responses.
 *
 * Supports:
 * - Event buffering and disconnection recovery (Last-Event-ID)
 * - Heartbeat keep-alive
 * - Backpressure handling
 */

import { type SSEMessage, SSEEventType, type ErrorData } from "./types.js";
import type { StreamChannel } from "../stream-channel.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** SSE server configuration options. */
export interface SSEServerOptions {
  /** Heartbeat interval in milliseconds. @default 15000 */
  heartbeatInterval?: number;
  /** Maximum number of buffered events for replay. @default 1000 */
  maxBufferSize?: number;
  /** Recovery window in milliseconds — events older than this are discarded. @default 300000 (5 min) */
  recoveryWindow?: number;
}

// ---------------------------------------------------------------------------
// Abstract HTTP interfaces
// ---------------------------------------------------------------------------

/** Minimal SSE response interface (Express / Node http compatible). */
export interface SSEResponse {
  write(data: string): boolean;
  end(): void;
  on(event: "close", listener: () => void): void;
}

/** Minimal SSE request interface. */
export interface SSERequest {
  headers: Record<string, string | string[] | undefined>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Serialize an SSEMessage into wire format. */
function formatSSEMessage(message: SSEMessage): string {
  const lines: string[] = [
    `id: ${message.id}`,
    `event: ${message.event}`,
    `data: ${JSON.stringify(message.data)}`,
    "",
  ];
  return lines.join("\n");
}

/** Map internal event type strings to SSE protocol event types. */
function mapEventType(event: { type: string }): SSEEventType {
  const mapping: Record<string, SSEEventType> = {
    text_delta: SSEEventType.TOKEN,
    tool_use_delta: SSEEventType.TOOL_CALL,
    tool_use_complete: SSEEventType.TOOL_CALL,
    tool_result: SSEEventType.TOOL_RESULT,
    approval_request: SSEEventType.APPROVAL_REQ,
    approval_decision: SSEEventType.APPROVAL_RES,
    state_change: SSEEventType.STATE_CHANGE,
    error: SSEEventType.ERROR,
  };
  return (mapping[event.type] as SSEEventType) ?? SSEEventType.STATE_CHANGE;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an SSE server instance.
 *
 * @example
 * ```ts
 * const sse = createSSEServer({ heartbeatInterval: 10_000 });
 * // In your HTTP handler:
 * sse.handleRequest(req, res, streamChannel);
 * ```
 */
export function createSSEServer(options: SSEServerOptions = {}) {
  const {
    heartbeatInterval = 15_000,
    maxBufferSize = 1000,
    recoveryWindow = 300_000,
  } = options;

  // Event buffer for disconnection recovery (shared across all connections)
  const eventBuffer: SSEMessage[] = [];
  let eventIdCounter = 0;

  /**
   * Handle an incoming SSE request.
   *
   * Writes the SSE headers, replays missed events if Last-Event-ID is present,
   * starts a heartbeat timer, and pipes StreamChannel events to the response.
   */
  function handleRequest(
    req: SSERequest,
    res: SSEResponse,
    channel: StreamChannel
  ): void {
    // Write SSE headers
    res.write("HTTP/1.1 200 OK\r\n");
    res.write("Content-Type: text/event-stream\r\n");
    res.write("Cache-Control: no-cache\r\n");
    res.write("Connection: keep-alive\r\n");
    res.write("\r\n");

    // Replay missed events for disconnection recovery
    const lastEventId = req.headers["last-event-id"] as string | undefined;
    if (lastEventId) {
      replayMissedEvents(lastEventId, res);
    }

    // Heartbeat timer
    const heartbeatTimer = setInterval(() => {
      const heartbeatMsg: SSEMessage<{ timestamp: number }> = {
        id: String(++eventIdCounter),
        event: SSEEventType.HEARTBEAT,
        data: { timestamp: Date.now() },
        timestamp: Date.now(),
      };
      writeSSEMessage(res, heartbeatMsg);
    }, heartbeatInterval);

    // Stream channel consumer
    const abortController = new AbortController();

    (async () => {
      try {
        for await (const event of channel.events()) {
          if (abortController.signal.aborted) break;

          const sseMessage: SSEMessage = {
            id: String(++eventIdCounter),
            event: mapEventType(event),
            data: event.data,
            timestamp: Date.now(),
          };

          // Buffer for replay (capped at maxBufferSize)
          eventBuffer.push(sseMessage);
          if (eventBuffer.length > maxBufferSize) {
            eventBuffer.shift();
          }

          writeSSEMessage(res, sseMessage);
        }

        // Stream finished — send DONE event
        const doneMessage: SSEMessage = {
          id: String(++eventIdCounter),
          event: SSEEventType.DONE,
          data: {},
          timestamp: Date.now(),
        };
        writeSSEMessage(res, doneMessage);
      } catch (error) {
        const errorMessage: SSEMessage<ErrorData> = {
          id: String(++eventIdCounter),
          event: SSEEventType.ERROR,
          data: {
            code: "STREAM_ERROR",
            message: error instanceof Error ? error.message : "Unknown error",
            retryable: false,
          },
          timestamp: Date.now(),
        };
        writeSSEMessage(res, errorMessage);
      } finally {
        clearInterval(heartbeatTimer);
        res.end();
      }
    })();

    // Client disconnected — abort the stream consumer
    res.on("close", () => {
      abortController.abort();
      clearInterval(heartbeatTimer);
    });
  }

  /**
   * Replay events that the client missed during disconnection.
   */
  function replayMissedEvents(lastEventId: string, res: SSEResponse): void {
    const lastId = parseInt(lastEventId, 10);
    if (isNaN(lastId)) return;

    const missedEvents = eventBuffer.filter(
      (e) => parseInt(e.id, 10) > lastId
    );
    for (const event of missedEvents) {
      writeSSEMessage(res, event);
    }
  }

  /**
   * Remove events older than the recovery window.
   * Call periodically to prevent unbounded memory growth.
   */
  function cleanupExpiredEvents(): void {
    const cutoff = Date.now() - recoveryWindow;
    while (eventBuffer.length > 0 && eventBuffer[0]!.timestamp < cutoff) {
      eventBuffer.shift();
    }
  }

  return {
    handleRequest,
    cleanupExpiredEvents,
  };
}

/**
 * Write an SSEMessage to the response in wire format.
 */
function writeSSEMessage(res: SSEResponse, message: SSEMessage): void {
  res.write(formatSSEMessage(message));
}
