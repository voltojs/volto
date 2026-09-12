/**
 * Sub-agent routing key tests.
 *
 * The routing layer decides where an SSE frame lands: the main conversation
 * buffer (null) or a per-childSessionId bucket (a string key). Depth-0
 * traffic — including the subagent_started/subagent_finished brackets
 * themselves — stays on the main feed; only tagged (agentDepth > 0) frames
 * are diverted. Routing tags ride on `data` at runtime and are not part of
 * the typed TranscriptEventMap, so fixtures here cast like the chat-store
 * tests do.
 */

import { describe, expect, it } from 'vitest';
import {
  deltaChildId,
  eventChildId,
  UNTAGGED_BUCKET,
} from '@/lib/subagent-routing';

describe('subagent routing keys', () => {
  it('routes tagged events to their child bucket', () => {
    expect(
      eventChildId({
        time: 1,
        type: 'model_call_start',
        data: { agentDepth: 1, childSessionId: 's-sub-0' },
      } as never),
    ).toBe('s-sub-0');
  });

  it('keeps depth-0 events (incl. the subagent bracket) on the main feed', () => {
    expect(
      eventChildId({
        time: 1,
        type: 'subagent_started',
        data: { childSessionId: 's-sub-0', depth: 1 },
      } as never),
    ).toBeNull();
  });

  it('falls back to the untagged bucket when childSessionId is missing', () => {
    expect(
      eventChildId({
        time: 1,
        type: 'model_call_start',
        data: { agentDepth: 1 },
      } as never),
    ).toBe(UNTAGGED_BUCKET);
  });

  it('routes tagged deltas by their childSessionId field', () => {
    expect(
      deltaChildId({
        kind: 'text',
        text: 'x',
        agentDepth: 1,
        childSessionId: 's-sub-1',
      }),
    ).toBe('s-sub-1');
    expect(deltaChildId({ kind: 'text', text: 'x' })).toBeNull();
  });
});
