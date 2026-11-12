/**
 * Event mapper — wraps transcript events and deltas into the wire-level SSE
 * frames defined in `./types.ts`.
 *
 * Hosts (gateway, desktop, future mobile gateways) share this mapper
 * so every transport speaks the same protocol. The mapper is stateful only in
 * the event id counter used for Last-Event-ID recovery.
 */

import { SSEFrameType, type SSEMessage, type ErrorData, type ConnectedData, type TaggedTranscriptDelta } from "./types.js";
import type { TranscriptEventInput } from "@volto/core";

export interface EventMapperOptions {
  /** Starting value for the event id counter. @default 0 */
  startId?: number;
  /** Clock used for frame timestamps. @default Date.now */
  now?: () => number;
}

/**
 * Wraps transcript events and deltas into wire frames.
 *
 * Stateful only in the id counter. The v1 mapper also accumulated streamed
 * text so a dropped TOKEN frame could be recovered from the next one's full
 * `content`; v2 does not need that — a dropped delta is corrected by the
 * next authoritative event.
 */
export function createEventMapper(options: EventMapperOptions = {}) {
  const { startId = 0, now = Date.now } = options;
  let eventId = startId;

  /** An authoritative, replayable frame. */
  function event(input: TranscriptEventInput): SSEMessage<TranscriptEventInput> {
    return { id: String(++eventId), event: SSEFrameType.EVENT, data: input, timestamp: now() };
  }

  /**
   * A streaming increment. Shares the last event's id — it is not replayable.
   * Accepts `TaggedTranscriptDelta` so sub-agent routing tags ride along
   * verbatim; plain deltas (the common case) are unchanged on the wire.
   */
  function delta(increment: TaggedTranscriptDelta): SSEMessage<TaggedTranscriptDelta> {
    return { id: String(eventId), event: SSEFrameType.DELTA, data: increment, timestamp: now() };
  }

  function heartbeat(): SSEMessage<{ timestamp: number }> {
    return { id: String(eventId), event: SSEFrameType.HEARTBEAT, data: { timestamp: now() }, timestamp: now() };
  }

  function error(message: string, code = "STREAM_ERROR", retryable = false): SSEMessage<ErrorData> {
    return {
      id: String(++eventId),
      event: SSEFrameType.ERROR,
      data: { code, message, retryable },
      timestamp: now(),
    };
  }

  /**
   * The once-per-connection frame carrying the fresh approval token. Shares
   * the heartbeat's id-counter discipline (does not increment `eventId`):
   * it is connection-scoped, not part of the replayable transcript, and
   * must never be replayed to a reconnecting client from the shared buffer
   * (a new connection always gets a new token) — see sessions.ts's `attach`.
   */
  function connected(token: string): SSEMessage<ConnectedData> {
    return { id: String(eventId), event: SSEFrameType.CONNECTED, data: { token }, timestamp: now() };
  }

  return { event, delta, heartbeat, error, connected };
}

/** Serialize an `SSEMessage` into the SSE wire format. */
export function formatSSEFrame(message: SSEMessage): string {
  return `id: ${message.id}\nevent: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`;
}
