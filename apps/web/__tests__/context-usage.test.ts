import { describe, it, expect } from 'vitest';
import {
  emptyContextUsageSnapshot,
  type ContextUsageSnapshot,
  type TranscriptEventInput,
} from '@voltojs/sdk/sse';
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
  it('seeds from the stored snapshot and folds live events on top', () => {
    const seed: ContextUsageSnapshot = {
      headerEstimate: { system: 10, tools: 0, layers: [{ id: 'system-prompt', tokens: 10 }] },
      anchor: { promptTokens: 40, outputTokens: 6 },
      pendingTokens: 0,
      messageTokens: 0,
    };
    const { snapshot, view } = projectContextUsage(seed, events([]), true);
    expect(snapshot.anchor).toEqual({ promptTokens: 40, outputTokens: 6 });
    expect(view).not.toBeNull();
    expect(view!.anchored).toBe(true);
  });

  it('accumulates new user messages beyond the seed', () => {
    const seed: ContextUsageSnapshot = {
      headerEstimate: { system: 10, tools: 0, layers: [{ id: 'system-prompt', tokens: 10 }] },
      anchor: { promptTokens: 40, outputTokens: 6 },
      pendingTokens: 0,
      messageTokens: 0,
    };
    const next: TranscriptEventInput = {
      time: 2,
      type: 'user_message',
      data: { content: 'abcdefgh' },
    } as TranscriptEventInput;
    const { view } = projectContextUsage(seed, [next], true);
    // 40 + 6 + (2(8 chars) + BLOCK_OVERHEAD 4 + ROLE_OVERHEAD 4 = 10)
    expect(view!.projectedTokens).toBe(56);
  });

  it('returns the seed view unchanged when the buffer is not current', () => {
    const { view } = projectContextUsage(
      {
        headerEstimate: { system: 10, tools: 0, layers: [{ id: 'system-prompt', tokens: 10 }] },
        anchor: { promptTokens: 40, outputTokens: 6 },
        pendingTokens: 0,
        messageTokens: 0,
      },
      events([]),
      false,
    );
    expect(view!.projectedTokens).toBe(46);
  });

  it('treats a missing seed as the empty snapshot', () => {
    const { snapshot, view } = projectContextUsage(undefined, [], true);
    expect(snapshot).toEqual(emptyContextUsageSnapshot());
    expect(view).toBeNull();
  });

  it('continues a server snapshot with live events', () => {
    const seed: ContextUsageSnapshot = {
      headerEstimate: { system: 10, tools: 5, layers: [{ id: 'sys', tokens: 10 }] },
      anchor: { promptTokens: 100, outputTokens: 10 },
      pendingTokens: 0,
      messageTokens: 40,
    };
    const { view } = projectContextUsage(
      seed,
      [{ time: 0, type: 'user_message', data: { content: 'abcd' } }],
      true,
    );
    // 100 + 10 anchor, plus the new message's estimate on top.
    expect(view!.projectedTokens).toBeGreaterThan(110);
    expect(view!.breakdown.messages).toBeGreaterThan(40);
  });

  it('treats a missing snapshot as an empty seed', () => {
    const { view } = projectContextUsage(null, [], true);
    expect(view).toBeNull();
  });

  it("renders a non-live buffer's seed as-is", () => {
    const seed: ContextUsageSnapshot = {
      headerEstimate: { system: 10, tools: 5, layers: [] },
      anchor: null,
      pendingTokens: 0,
      messageTokens: 7,
    };
    const { view } = projectContextUsage(
      seed,
      [{ time: 0, type: 'user_message', data: { content: 'ignored' } }],
      false,
    );
    expect(view!.projectedTokens).toBe(22);
  });
});
