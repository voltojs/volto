/**
 * SSE Client — connects to an SSE server, parses the wire format, and
 * delivers frames through an event-subscription API.
 *
 * Protocol v2 has three subscription channels for payload frames — `onEvent`
 * for authoritative transcript events, `onDelta` for streaming increments,
 * and `onError` for `error` frames (pre-stream failures such as config
 * resolution errors or BUSY). Heartbeat frames are handled by the connection
 * layer and never surfaced to subscribers.
 *
 * Supports:
 * - Auto-reconnect with exponential back-off
 * - Disconnection recovery (Last-Event-ID header)
 * - Typed event subscriptions
 * - Connection state management
 */

import {
  SSEFrameType,
  type SSEMessage,
  type ConnectionState,
  type ErrorData,
  type ConnectedData,
  type TaggedTranscriptDelta,
} from "./types.js";
import type { TranscriptEventInput } from "@volto/core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** SSE client configuration options. */
export interface SSEClientOptions {
  /** Enable automatic reconnection on failure. @default true */
  autoReconnect?: boolean;
  /** Initial reconnect delay in milliseconds. @default 1000 */
  reconnectDelay?: number;
  /** Maximum reconnect delay in milliseconds (cap for back-off). @default 30000 */
  maxReconnectDelay?: number;
  /** Maximum number of consecutive reconnect attempts. @default 10 */
  maxReconnectAttempts?: number;
}

// ---------------------------------------------------------------------------
// Abstract EventSource interface
// ---------------------------------------------------------------------------

/** Minimal EventSource interface — compatible with both browser and polyfills. */
export interface EventSourceLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  removeEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}

/** Factory function that creates an EventSource for a given URL. */
export type EventSourceFactory = (url: string) => EventSourceLike;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an SSE client instance.
 *
 * @example
 * ```ts
 * const client = createSSEClient("http://localhost:3000/sse");
 * client.onEvent((event) => store.pushEvent(event));
 * client.onDelta((delta) => store.pushDelta(delta));
 * client.onError((data) => console.error(data.code, data.message));
 * client.connect();
 * // later...
 * client.disconnect();
 * ```
 */
export function createSSEClient(url: string, options: SSEClientOptions = {}) {
  const {
    autoReconnect = true,
    reconnectDelay = 1000,
    maxReconnectDelay = 30_000,
    maxReconnectAttempts = 10,
  } = options;

  let eventSource: EventSourceLike | null = null;
  let state: ConnectionState = "disconnected";
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastEventId = "";
  /**
   * The fresh per-connection approval token learned from the CONNECTED
   * frame. Reset to null on every disconnect/reconnect — a new connection
   * always gets a new token, and the caller must never send a stale one.
   */
  let connectionToken: string | null = null;
  let factory: EventSourceFactory =
    typeof globalThis.EventSource !== "undefined"
      ? (u: string) => new globalThis.EventSource(u) as unknown as EventSourceLike
      : (u: string) => {
          throw new Error(
            `EventSource is not available. Provide a custom factory via setEventSourceFactory. URL: ${u}`
          );
        };

  const eventHandlers = new Set<(event: TranscriptEventInput) => void>();
  const deltaHandlers = new Set<(delta: TaggedTranscriptDelta) => void>();
  const errorHandlers = new Set<(data: ErrorData) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();

  // -- internal helpers -----------------------------------------------------

  function setState(next: ConnectionState): void {
    if (state === next) return;
    state = next;
    for (const handler of stateListeners) {
      handler(state);
    }
  }

  /** Route a parsed frame to the matching subscription channel. */
  function notify(message: SSEMessage): void {
    if (message.event === SSEFrameType.EVENT) {
      for (const handler of eventHandlers) {
        handler(message.data as TranscriptEventInput);
      }
    } else if (message.event === SSEFrameType.DELTA) {
      for (const handler of deltaHandlers) {
        handler(message.data as TaggedTranscriptDelta);
      }
    } else if (message.event === SSEFrameType.ERROR) {
      for (const handler of errorHandlers) {
        handler(message.data as ErrorData);
      }
    } else if (message.event === SSEFrameType.CONNECTED) {
      connectionToken = (message.data as ConnectedData).token;
    }
  }

  function handleOpen(): void {
    reconnectAttempts = 0;
    setState("connected");
  }

  function handleError(): void {
    eventSource?.close();
    eventSource = null;
    // The connection just died: whatever token it carried is no longer
    // live on the server (a dropped channel settles every pending approval
    // as "deny" — see sessions.ts's `detach`), and a reconnect gets an
    // entirely new one. Never let a stale token linger across this gap.
    connectionToken = null;

    if (autoReconnect && reconnectAttempts < maxReconnectAttempts) {
      setState("disconnected");

      const delay = Math.min(
        reconnectDelay * 2 ** reconnectAttempts,
        maxReconnectDelay
      );

      reconnectTimer = setTimeout(() => {
        reconnectAttempts++;
        connect();
      }, delay);
    } else {
      setState("disconnected");
    }
  }

  // -- public API -----------------------------------------------------------

  /**
   * Replace the default EventSource factory (useful for Node.js polyfills).
   */
  function setEventSourceFactory(fn: EventSourceFactory): void {
    factory = fn;
  }

  /** Open the SSE connection. */
  function connect(): void {
    if (state === "connected" || state === "connecting") return;

    setState("connecting");

    try {
      // Append Last-Event-ID as query param for servers that read it there
      const connectUrl = lastEventId
        ? `${url}${url.includes("?") ? "&" : "?"}last-event-id=${encodeURIComponent(lastEventId)}`
        : url;

      eventSource = factory(connectUrl);

      eventSource.onopen = () => handleOpen();

      // Register listeners for each SSEFrameType so browser-dispatched named
      // frames are captured. This is the primary message path.
      for (const frameType of Object.values(SSEFrameType)) {
        eventSource.addEventListener(frameType, (event: MessageEvent) => {
          try {
            const data: unknown = JSON.parse(event.data as string);
            // Browser EventSource sets lastEventId from the wire "id:" field
            if (event.lastEventId) {
              lastEventId = event.lastEventId;
            }
            const message: SSEMessage = {
              id: lastEventId,
              event: frameType,
              data,
              timestamp: Date.now(),
            };
            notify(message);
          } catch {
            // ignore parse errors on named frames
          }
        });
      }

      eventSource.onerror = () => handleError();
    } catch {
      handleError();
    }
  }

  /** Close the SSE connection and cancel any pending reconnect. */
  function disconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    eventSource?.close();
    eventSource = null;

    setState("disconnected");
    reconnectAttempts = 0;
    lastEventId = "";
    connectionToken = null;
  }

  /** Subscribe to authoritative transcript events. Returns an unsubscribe function. */
  function onEvent(handler: (event: TranscriptEventInput) => void): () => void {
    eventHandlers.add(handler);
    return () => {
      eventHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to streaming increments. Handlers receive a
   * `TaggedTranscriptDelta`: sub-agent deltas carry `agentDepth` /
   * `childSessionId`, main-agent deltas are plain. Returns an unsubscribe
   * function.
   */
  function onDelta(handler: (delta: TaggedTranscriptDelta) => void): () => void {
    deltaHandlers.add(handler);
    return () => {
      deltaHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to protocol `error` frames (pre-stream failures such as config
   * resolution errors or BUSY). Returns an unsubscribe function.
   */
  function onError(handler: (data: ErrorData) => void): () => void {
    errorHandlers.add(handler);
    return () => {
      errorHandlers.delete(handler);
    };
  }

  /** Subscribe to connection state changes. Returns an unsubscribe function. */
  function onStateChange(handler: (state: ConnectionState) => void): () => void {
    stateListeners.add(handler);
    return () => {
      stateListeners.delete(handler);
    };
  }

  /** Current connection state. */
  function getState(): ConnectionState {
    return state;
  }

  /** Get the last received event ID (useful for debugging / manual replay). */
  function getLastEventId(): string {
    return lastEventId;
  }

  /**
   * The current connection's approval token, or null before the CONNECTED
   * frame has arrived (or after a disconnect). Callers must send this back
   * verbatim on `POST /approvals` for any approval shown on this channel.
   */
  function getConnectionToken(): string | null {
    return connectionToken;
  }

  /** Tear down all listeners and cancel reconnect. */
  function destroy(): void {
    disconnect();
    eventHandlers.clear();
    deltaHandlers.clear();
    errorHandlers.clear();
    stateListeners.clear();
  }

  return {
    connect,
    disconnect,
    onEvent,
    onDelta,
    onError,
    onStateChange,
    getState,
    getLastEventId,
    getConnectionToken,
    setEventSourceFactory,
    destroy,
  };
}
