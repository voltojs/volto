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

import type { TranscriptDelta } from "@volto/core";

/**
 * Wire frame kinds.
 *
 * `EVENT` carries a `TranscriptEventInput` verbatim — the same shape that
 * gets persisted, so a client projects live and historical data with one
 * function. `DELTA` carries a streaming increment that is never persisted;
 * losing one is self-healing because the next EVENT replaces the partial.
 * `CONNECTED` carries the fresh per-connection approval token (see
 * `ConnectedData`) exactly once, right after the channel opens — only a
 * subscriber of this exact connection ever learns it, which is what makes
 * `POST /approvals`'s token check meaningful (see sessions.ts's `attach`).
 */
export enum SSEFrameType {
  EVENT = "event",
  DELTA = "delta",
  HEARTBEAT = "heartbeat",
  /** Transport-level failure only. Agent errors travel as transcript events. */
  ERROR = "error",
  /** Sent once per connection, immediately after it opens. See `ConnectedData`. */
  CONNECTED = "connected",
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
// Tagged delta payload
// ---------------------------------------------------------------------------

/**
 * A delta frame that may carry sub-agent routing metadata. Fields are
 * optional and absent on main-agent deltas; old clients ignore them and
 * old servers never send them (spec 2026-09-12 §4.2).
 */
export type TaggedTranscriptDelta = TranscriptDelta & {
  agentDepth?: number;
  childSessionId?: string;
};

// ---------------------------------------------------------------------------
// Connected payload
// ---------------------------------------------------------------------------

/**
 * Payload of the once-per-connection `CONNECTED` frame — a fresh random
 * token bound to this exact SSE connection. The client must echo it back on
 * `POST /approvals` for any approval it was shown on this channel; the
 * server rejects a missing or mismatched token with 403 (see
 * `apps/headless-server`'s `sessions.ts`/`server.ts`).
 */
export interface ConnectedData {
  token: string;
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

/** Client-side SSE connection state. */
export type ConnectionState = "connecting" | "connected" | "disconnected";
