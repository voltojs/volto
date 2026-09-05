/**
 * SSE (Server-Sent Events) wire types for the volto SDK.
 *
 * Protocol v2 has four frame kinds — `event` (authoritative transcript
 * events), `delta` (streaming increments, never persisted), `heartbeat`
 * (keep-alive) and `error` (transport-level failures only) — plus the
 * client-side connection state machine.
 */

// ---------------------------------------------------------------------------
// Frame type enum
// ---------------------------------------------------------------------------

/**
 * Wire frame kinds.
 *
 * `EVENT` carries a `TranscriptEventInput` verbatim — the same shape that
 * gets persisted, so a client projects live and historical data with one
 * function. `DELTA` carries a streaming increment that is never persisted;
 * losing one is self-healing because the next EVENT replaces the partial.
 */
export enum SSEFrameType {
  EVENT = "event",
  DELTA = "delta",
  HEARTBEAT = "heartbeat",
  /** Transport-level failure only. Agent errors travel as transcript events. */
  ERROR = "error",
}

// ---------------------------------------------------------------------------
// Unified message envelope
// ---------------------------------------------------------------------------

/** Unified SSE message envelope. `T` defaults to `unknown`. */
export interface SSEMessage<T = unknown> {
  /** Monotonic, for Last-Event-ID recovery. Only EVENT frames consume one. */
  id: string;
  /** Frame type discriminator. */
  event: SSEFrameType;
  /** Frame payload. */
  data: T;
  /** Server-side timestamp in milliseconds (epoch). */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Error payload
// ---------------------------------------------------------------------------

/** Transport-level error frame payload. */
export interface ErrorData {
  /** Machine-readable error code. */
  code: string;
  /** Human-readable error message. */
  message: string;
  /** Whether the client may safely retry. */
  retryable: boolean;
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

/** Client-side SSE connection state. */
export type ConnectionState = "connecting" | "connected" | "disconnected";
