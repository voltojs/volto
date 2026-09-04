/**
 * Event mapper — wraps transcript events and deltas into the wire-level SSE
 * frames defined in `./types.ts`.
 *
 * Hosts (headless-server, desktop, future mobile gateways) share this mapper
 * so every transport speaks the same protocol. The mapper is stateful only in
 * the event id counter used for Last-Event-ID recovery.
 */

import { SSEFrameType, type SSEMessage, type ErrorData } from "./types.js";
import type { TranscriptDelta, TranscriptEventInput } from "@volto/core";

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

  /** A streaming increment. Shares the last event's id — it is not replayable. */
  function delta(increment: TranscriptDelta): SSEMessage<TranscriptDelta> {
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

  return { event, delta, heartbeat, error };
}

/** Serialize an `SSEMessage` into the SSE wire format. */
export function formatSSEFrame(message: SSEMessage): string {
  return `id: ${message.id}\nevent: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`;
}
