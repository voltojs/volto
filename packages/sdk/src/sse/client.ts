/**
 * SSE Client — connects to an SSE server, parses the wire format, and
 * delivers typed messages through an event-subscription API.
 *
 * Supports:
 * - Auto-reconnect with exponential back-off
 * - Disconnection recovery (Last-Event-ID header)
 * - Typed event subscriptions
 * - Connection state management
 */

import { type SSEMessage, type ConnectionState } from "./types.js";

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
  close(): void;
}

/** Factory function that creates an EventSource for a given URL. */
export type EventSourceFactory = (url: string) => EventSourceLike;

// ---------------------------------------------------------------------------
// SSE wire-format parser
// ---------------------------------------------------------------------------

/**
 * Parse a single SSE data block into an SSEMessage.
 *
 * Expected wire format per event:
 * ```
 * id: <string>
 * event: <string>
 * data: <json-string>
 * ```
 */
function parseSSEData(raw: string): SSEMessage | null {
  const lines = raw.split("\n");
  let id = "";
  let event = "";
  let data = "";

  for (const line of lines) {
    if (line.startsWith("id: ")) {
      id = line.slice(4);
    } else if (line.startsWith("event: ")) {
      event = line.slice(7);
    } else if (line.startsWith("data: ")) {
      data = line.slice(6);
    }
  }

  if (!event) return null;

  try {
    const parsed: unknown = data ? JSON.parse(data) : {};
    return { id, event: event as SSEMessage["event"], data: parsed, timestamp: Date.now() };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an SSE client instance.
 *
 * @example
 * ```ts
 * const client = createSSEClient("http://localhost:3000/sse");
 * client.on("token", (data) => console.log(data.delta));
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
  let factory: EventSourceFactory =
    typeof globalThis.EventSource !== "undefined"
      ? (u: string) => new globalThis.EventSource(u) as unknown as EventSourceLike
      : (u: string) => {
          throw new Error(
            `EventSource is not available. Provide a custom factory via setEventSourceFactory. URL: ${u}`
          );
        };

  const listeners = new Map<string, Set<(msg: SSEMessage) => void>>();
  const stateListeners = new Set<(state: ConnectionState) => void>();

  // -- internal helpers -----------------------------------------------------

  function setState(next: ConnectionState): void {
    if (state === next) return;
    state = next;
    for (const handler of stateListeners) {
      handler(state);
    }
  }

  function notifyListeners(message: SSEMessage): void {
    // Type-specific listeners
    const handlers = listeners.get(message.event);
    if (handlers) {
      for (const handler of handlers) {
        handler(message);
      }
    }
    // Wildcard listeners (receive the full SSEMessage)
    const wildcards = listeners.get("*");
    if (wildcards) {
      for (const handler of wildcards) {
        handler(message);
      }
    }
  }

  function handleOpen(): void {
    reconnectAttempts = 0;
    setState("connected");
  }

  function handleMessage(event: MessageEvent): void {
    // If the server sends raw SSE wire format via the browser EventSource,
    // each event already has .data populated by the browser parser.
    // For browser EventSource: event.data is the raw "data:" line content.
    // For our wire format we pack id+event+data into a JSON envelope,
    // so try parsing JSON first, then fall back to wire-format parsing.
    let message: SSEMessage | null = null;

    try {
      const parsed: unknown = JSON.parse(event.data as string);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "event" in parsed &&
        "data" in parsed
      ) {
        message = parsed as SSEMessage;
      }
    } catch {
      // Not JSON — try wire-format parsing
    }

    if (!message) {
      message = parseSSEData(event.data as string);
    }

    if (message) {
      if (message.id) {
        lastEventId = message.id;
      }
      notifyListeners(message);
    }
  }

  function handleError(): void {
    eventSource?.close();
    eventSource = null;

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

      // Browser EventSource fires named events; also listen to the default
      // "message" handler for JSON-envelope payloads.
      eventSource.onmessage = (event: MessageEvent) => handleMessage(event);

      // Register listeners for each SSEEventType so browser-dispatched
      // named events are also captured.
      for (const eventType of [
        "token",
        "tool_call",
        "tool_result",
        "approval_req",
        "approval_res",
        "state_change",
        "error",
        "heartbeat",
        "done",
      ]) {
        eventSource.addEventListener(eventType, (event: MessageEvent) => {
          try {
            const data: unknown = JSON.parse(event.data as string);
            // Browser EventSource sets lastEventId from the wire "id:" field
            if (event.lastEventId) {
              lastEventId = event.lastEventId;
            }
            const message: SSEMessage = {
              id: lastEventId,
              event: eventType as SSEMessage["event"],
              data,
              timestamp: Date.now(),
            };
            notifyListeners(message);
          } catch {
            // ignore parse errors on named events
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
  }

  /**
   * Subscribe to a specific event type. Returns an unsubscribe function.
   *
   * - Typed event (e.g. `SSEEventType.TOKEN`): handler receives `data` only.
   * - Wildcard `"*"`: handler receives the full `SSEMessage` envelope.
   */
  function on<T = unknown>(
    eventType: SSEMessage["event"] | "*",
    handler: (payload: T) => void
  ): () => void {
    if (!listeners.has(eventType)) {
      listeners.set(eventType, new Set());
    }

    let wrapped: (msg: SSEMessage) => void;
    if (eventType === "*") {
      // Wildcard: pass the full message envelope
      wrapped = (msg: SSEMessage) => handler(msg as T);
    } else {
      // Typed: pass data only
      wrapped = (msg: SSEMessage) => handler(msg.data as T);
    }
    listeners.get(eventType)!.add(wrapped);

    return () => {
      listeners.get(eventType)?.delete(wrapped);
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

  /** Tear down all listeners and cancel reconnect. */
  function destroy(): void {
    disconnect();
    listeners.clear();
    stateListeners.clear();
  }

  return {
    connect,
    disconnect,
    on,
    onStateChange,
    getState,
    getLastEventId,
    setEventSourceFactory,
    destroy,
  };
}
