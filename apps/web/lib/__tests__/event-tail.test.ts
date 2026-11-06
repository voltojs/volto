import { describe, it, expect } from 'vitest';
import type { TranscriptEventInput } from '@volto/sdk/sse';
import { eventKey, mergeEventTail } from '@/lib/event-tail';

function ev(
  type: string,
  time: number,
  data: Record<string, unknown> = {},
  turn?: number,
): TranscriptEventInput {
  return { type, time, data, ...(turn !== undefined ? { turn } : {}) } as TranscriptEventInput;
}

describe('mergeEventTail — reconnect tail + live stream', () => {
  it('returns the live buffer untouched when the session was idle', () => {
    const live = [ev('turn_start', 10), ev('user_message', 11, { content: 'hi' })];
    expect(mergeEventTail([], live)).toEqual(live);
  });

  it('puts the replayed tail in front and drops the overlapping live copy', () => {
    const a = ev('turn_start', 10);
    const b = ev('user_message', 11, { content: 'sleep 60' });
    const c = ev('assistant_message', 12, { content: [] });
    const d = ev('turn_end', 20, { reason: 'done' });
    expect(mergeEventTail([a, b, c], [b, c, d])).toEqual([a, b, c, d]);
  });

  it('never merges two distinct events that share a type and time', () => {
    const first = ev('tool_result', 30, { results: [{ callId: 'call-1' }] });
    const second = ev('tool_result', 30, { results: [{ callId: 'call-2' }] });
    expect(eventKey(first)).not.toBe(eventKey(second));
    expect(mergeEventTail([first], [second])).toEqual([first, second]);
  });
});
