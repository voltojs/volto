/**
 * Reconnect tail (F-16): a fresh SSE connection gets no replay, so a page
 * that reloads mid-turn must rebuild the running turn from
 * `GET /sessions/:id/events?tail=1` — otherwise the composer shows idle (no
 * Stop) and a later `tool_result` has no batch to land in.
 *
 * The hook itself is mounted with the same fake-client harness as
 * use-chat-agent-routing.test.tsx; only the tail request is stubbed so each
 * case controls what the gateway answers and when.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useChatAgent } from '../hooks/use-chat-agent.js';
import { useSessionStore } from '../stores/session-store.js';
import { useChatStore } from '../stores/chat-store.js';
import { summary } from './helpers/session.js';
import type { TranscriptEventInput } from '@volto/sdk/sse';

const channel: { onEvent?: (event: TranscriptEventInput) => void } = {};

const tail = vi.hoisted(() => ({
  impl: null as null | (() => Promise<unknown>),
}));

vi.mock('@/lib/agent-config', async () => {
  const actual = await vi.importActual<typeof import('../lib/agent-config.js')>(
    '../lib/agent-config.js',
  );
  return {
    ...actual,
    createGatewaySSEClient: () => ({
      onStateChange: (cb: (state: string) => void) => {
        queueMicrotask(() => cb('connected'));
        return () => {};
      },
      connect: () => {},
      onEvent: (cb: (event: TranscriptEventInput) => void) => {
        channel.onEvent = cb;
        return () => {};
      },
      onDelta: () => () => {},
      onError: () => () => {},
      destroy: () => {},
    }),
    postMessage: async () => {},
    interruptTurn: async () => {},
  };
});

vi.mock('@/lib/sessions-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/sessions-api.js')>()),
  fetchSessionEventsTail: () =>
    tail.impl === null ? Promise.reject(new Error('no tail stub')) : tail.impl(),
}));

function ev(type: string, time: number, data: Record<string, unknown> = {}, turn = 1): TranscriptEventInput {
  return { type, time, data, turn } as TranscriptEventInput;
}

beforeEach(() => {
  channel.onEvent = undefined;
  tail.impl = null;
  useSessionStore.setState({
    sessions: [{ ...summary('s1'), projectId: 'p1', providerId: 'v1', modelId: 'm1' }],
    currentSessionId: 's1',
  });
  useChatStore.setState({
    events: [],
    deltas: [],
    isGenerating: false,
    subagents: {},
    notices: [],
    currentSessionId: 's1',
  });
});

describe('useChatAgent — reconnect into a running turn', () => {
  it('seeds the running turn tail and shows generating', async () => {
    tail.impl = async () => ({
      sessionId: 's1',
      running: true,
      events: [
        ev('turn_start', 10),
        ev('user_message', 11, { content: 'sleep 60s' }),
        ev('assistant_message', 12, { content: [] }),
      ],
    });

    renderHook(() => useChatAgent());

    await waitFor(() => expect(useChatStore.getState().isGenerating).toBe(true));
    expect(useChatStore.getState().events.map((e) => e.type)).toEqual([
      'turn_start',
      'user_message',
      'assistant_message',
    ]);
  });

  it('stays idle when a live turn_end already closed the tail turn', async () => {
    let resolveTail!: (value: unknown) => void;
    tail.impl = () =>
      new Promise((resolve) => {
        resolveTail = resolve;
      });

    renderHook(() => useChatAgent());
    await waitFor(() => expect(channel.onEvent).toBeTypeOf('function'));

    act(() => {
      channel.onEvent!(ev('turn_end', 20, { turn: 1, reason: 'done' }));
    });
    act(() => {
      resolveTail({
        sessionId: 's1',
        running: true,
        events: [ev('turn_start', 10)],
      });
    });

    await waitFor(() => expect(useChatStore.getState().events).toHaveLength(2));
    expect(useChatStore.getState().isGenerating).toBe(false);
  });
});
