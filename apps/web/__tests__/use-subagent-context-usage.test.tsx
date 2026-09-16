// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSubagentContextUsage } from '@/hooks/use-subagent-context-usage';
import { useChatStore } from '@/stores/chat-store';
import {
  setCachedSubagentEvents,
  clearSubagentCache,
} from '@/lib/subagent-cache';
import type { TranscriptEventInput } from '@volto/sdk/sse';

const HEADER = {
  hash: 'h1',
  systemLayers: [{ id: 'system-prompt', text: 'abcdefgh' }],
  tools: [],
  params: {},
};

const headerEvent = (): TranscriptEventInput =>
  ({ time: 0, type: 'request_header', data: HEADER }) as TranscriptEventInput;

const usageEvent = (
  time: number,
  inputTokens: number,
): TranscriptEventInput =>
  ({
    time,
    type: 'assistant_message',
    data: {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        inputTokens,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  }) as unknown as TranscriptEventInput;

describe('useSubagentContextUsage', () => {
  beforeEach(() => {
    clearSubagentCache();
    useChatStore.setState({ subagents: {}, events: [], deltas: [] });
  });

  it('returns null when there is no child or no events', () => {
    const { result: empty } = renderHook(() => useSubagentContextUsage(null));
    expect(empty.current).toBeNull();

    const { result: noEvents } = renderHook(() =>
      useSubagentContextUsage('c1'),
    );
    expect(noEvents.current).toBeNull();
  });

  it('returns null without a request_header (meter needs an anchor surface)', () => {
    useChatStore.setState({
      subagents: {
        c1: {
          events: [usageEvent(10, 1200)],
          deltas: [],
          status: 'running',
        },
      },
    });
    const { result } = renderHook(() => useSubagentContextUsage('c1'));
    expect(result.current).toBeNull();
  });

  it('folds live bucket events once a header is present', () => {
    useChatStore.setState({
      subagents: {
        c1: {
          events: [headerEvent(), usageEvent(10, 1200)],
          deltas: [],
          status: 'running',
        },
      },
    });
    const { result } = renderHook(() => useSubagentContextUsage('c1'));
    expect(result.current).not.toBeNull();
    expect(result.current!.anchored).toBe(true);
    // 1200 + 10 output
    expect(result.current!.projectedTokens).toBe(1210);
  });

  it('dedupes stored vs live copies of the same event', () => {
    const events = [headerEvent(), usageEvent(42, 800)];
    setCachedSubagentEvents('c1', events);
    useChatStore.setState({
      subagents: {
        c1: {
          events: events.map((e) => ({ ...e })),
          deltas: [],
          status: 'done',
        },
      },
    });
    const { result } = renderHook(() => useSubagentContextUsage('c1'));
    expect(result.current).not.toBeNull();
    // Single fold: 800 + 10, not doubled.
    expect(result.current!.projectedTokens).toBe(810);
  });
});
