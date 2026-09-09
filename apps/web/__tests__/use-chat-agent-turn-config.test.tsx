/**
 * What the send path actually puts on the wire.
 *
 * `postMessage` was already covered (agent-config.test.ts) and so was the
 * session store's own `reasoningEffort` bookkeeping — but nothing covered the
 * hook that assembles one from the other, and it silently dropped the tier.
 * Both ends green, the middle broken: this file tests the middle.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatAgent } from '../hooks/use-chat-agent.js';
import { useSessionStore } from '../stores/session-store.js';
import { summary } from './helpers/session.js';

const SENT: Array<Record<string, unknown>> = [];

vi.mock('@/lib/agent-config', async () => {
  const actual = await vi.importActual<typeof import('../lib/agent-config.js')>(
    '../lib/agent-config.js',
  );
  return {
    ...actual,
    // The hook awaits an open channel before posting; a no-op client keeps
    // this test on the turn-config assembly rather than SSE plumbing.
    createSSEClient: () => ({
      // `ensureConnection` resolves off the first 'open' state change; report
      // it asynchronously so the hook has subscribed by the time it lands. The hook resolves on 'connected', not 'open'.
      onStateChange: (cb: (state: string) => void) => {
        queueMicrotask(() => cb('connected'));
        return () => {};
      },
      connect: () => {},
      onEvent: () => () => {},
      onDelta: () => () => {},
      onError: () => () => {},
      destroy: () => {},
    }),
    postMessage: async (
      _sessionId: string,
      _content: string,
      config: Record<string, unknown>,
    ) => {
      SENT.push(config);
    },
    interruptTurn: async () => {},
  };
});

beforeEach(() => {
  SENT.length = 0;
  useSessionStore.setState({
    sessions: [
      {
        ...summary('s1'),
        projectId: 'p1',
        providerId: 'v1',
        modelId: 'm1',
        reasoningEffort: 'eff-high',
      },
    ],
    currentSessionId: 's1',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useChatAgent send path', () => {
  it("forwards the session's reasoningEffort into the turn config", async () => {
    const { result } = renderHook(() => useChatAgent());
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    expect(SENT).toHaveLength(1);
    expect(SENT[0]!['reasoningEffort']).toBe('eff-high');
    expect(SENT[0]!['modelId']).toBe('m1');
  });

  it('omits reasoningEffort for a session that has no tier selected', async () => {
    useSessionStore.setState({
      sessions: [
        { ...summary('s2'), projectId: 'p1', providerId: 'v1', modelId: 'm1' },
      ],
      currentSessionId: 's2',
    });
    const { result } = renderHook(() => useChatAgent());
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    expect(SENT[0]!['reasoningEffort']).toBeUndefined();
  });
});
