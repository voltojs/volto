import { describe, it, expect } from 'vitest';
import {
  emptyContextUsageFold,
  type ContextUsageFold,
  type TranscriptEventInput,
} from '@volto/sdk/sse';
import { projectContextUsage } from '@/lib/context-usage';

const HEADER = {
  hash: 'h1',
  systemLayers: [{ id: 'system-prompt', text: 'abcdefgh' }],
  tools: [],
  params: {},
};

const events = (extra: TranscriptEventInput[]): TranscriptEventInput[] => [
  { time: 0, type: 'user_message', data: { content: 'hi' } } as TranscriptEventInput,
  { time: 1, type: 'request_header', data: HEADER } as TranscriptEventInput,
  ...extra,
];

describe('projectContextUsage', () => {
  it('seeds from the stored fold and folds live events on top', () => {
    const seed: ContextUsageFold = {
      header: { systemLayers: HEADER.systemLayers, tools: [] },
      anchor: { promptTokens: 40, outputTokens: 6 },
      pendingTokens: 0,
    };
    const { fold, view } = projectContextUsage(seed, events([]), true);
    expect(fold.anchor).toEqual({ promptTokens: 40, outputTokens: 6 });
    expect(view).not.toBeNull();
    expect(view!.anchored).toBe(true);
  });

  it('accumulates new user messages beyond the seed', () => {
    const seed: ContextUsageFold = {
      header: { systemLayers: HEADER.systemLayers, tools: [] },
      anchor: { promptTokens: 40, outputTokens: 6 },
      pendingTokens: 0,
    };
    const next: TranscriptEventInput = {
      time: 2,
      type: 'user_message',
      data: { content: 'abcdefgh' },
    } as TranscriptEventInput;
    const { view } = projectContextUsage(seed, [next], true);
    // 40 + 6 + 2(8 chars)
    expect(view!.projectedTokens).toBe(48);
  });

  it('returns the seed view unchanged when the buffer is not current', () => {
    const { view } = projectContextUsage(
      { header: { systemLayers: HEADER.systemLayers, tools: [] }, anchor: { promptTokens: 40, outputTokens: 6 }, pendingTokens: 0 },
      events([]),
      false,
    );
    expect(view!.projectedTokens).toBe(46);
  });

  it('treats a missing seed as the empty fold', () => {
    const { fold, view } = projectContextUsage(undefined, [], true);
    expect(fold).toEqual(emptyContextUsageFold());
    expect(view).toBeNull();
  });

  it('seeds the fold from the session detail, not from a snapshot taken at switch time', () => {
    const seed = {
      header: { systemLayers: [{ id: 'sys', text: 'x'.repeat(40) }], tools: [] },
      anchor: { promptTokens: 100, outputTokens: 10 },
      pendingTokens: 0,
    };
    const { view } = projectContextUsage(seed, [], true);
    expect(view?.anchored).toBe(true);
    expect(view?.projectedTokens).toBe(110);
  });
});
