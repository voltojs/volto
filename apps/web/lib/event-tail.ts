/**
 * Reconnect tail handling: a fresh SSE connection gets no replay, so a client
 * that reloads mid-turn starts with an empty event buffer. The gateway can
 * hand back the in-flight turn's persisted events (`?tail=1`); merging those
 * in front of whatever the connection has already streamed rebuilds the
 * running turn — the generating indicator, the tool batch a later
 * `tool_result` resolves, and any queued `steering_queued` entries.
 */

import type { TranscriptEventInput } from '@voltojs/sdk/sse';

/** Identity of one event across the HTTP tail and the SSE stream. */
export function eventKey(event: TranscriptEventInput): string {
  return [
    event.type,
    event.time,
    event.turn ?? '',
    event.step ?? '',
    JSON.stringify(event.data),
  ].join('\u0000');
}

/**
 * The tail first, then the live events that arrived while it was being
 * fetched, minus the overlap. Order inside each side is preserved, so the
 * merged buffer is still the wire order.
 */
export function mergeEventTail(
  tail: readonly TranscriptEventInput[],
  live: readonly TranscriptEventInput[],
): TranscriptEventInput[] {
  if (tail.length === 0) return live as TranscriptEventInput[];
  const seen = new Set(tail.map(eventKey));
  return [...tail, ...live.filter((event) => !seen.has(eventKey(event)))];
}
