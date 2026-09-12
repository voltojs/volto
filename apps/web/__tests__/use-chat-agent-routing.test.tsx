/**
 * Wiring-level regression gate for the sub-agent routing glue.
 *
 * The store layer (chat-store.test.ts) and the routing key functions
 * (subagent-routing.test.ts) were each covered — but the onEvent/onDelta
 * handlers in use-chat-agent.ts that connect the fake transport to the
 * store had no test, so reverting them to bare pushEvent/pushDelta passed
 * the whole suite including the store-level gate. This file mounts the
 * hook itself (same fake-client fixture pattern as
 * use-chat-agent-turn-config.test.tsx) and drives frames through the
 * captured callbacks: the gate asserts the routing decision where it
 * actually happens, not two of the three links (AGENTS.md §2.1).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatAgent } from '../hooks/use-chat-agent.js';
import { useSessionStore } from '../stores/session-store.js';
import { useChatStore } from '../stores/chat-store.js';
import { summary } from './helpers/session.js';
import type {
  TaggedTranscriptDelta,
  TranscriptEventInput,
} from '@volto/sdk/sse';

/** The hook's channel callbacks, captured by the fake client below. */
const channel: {
  onEvent?: (event: TranscriptEventInput) => void;
  onDelta?: (delta: TaggedTranscriptDelta) => void;
} = {};

vi.mock('@/lib/agent-config', async () => {
  const actual = await vi.importActual<typeof import('../lib/agent-config.js')>(
    '../lib/agent-config.js',
  );
  return {
    ...actual,
    // Same fixture idea as use-chat-agent-turn-config.test.tsx, but this
    // fake client *captures* the hook's onEvent/onDelta handlers so the
    // test can emit frames through them.
    createGatewaySSEClient: () => ({
      // `ensureConnection` resolves off a 'connected' state change; fire it
      // asynchronously so the hook has subscribed by the time it lands.
      onStateChange: (cb: (state: string) => void) => {
        queueMicrotask(() => cb('connected'));
        return () => {};
      },
      connect: () => {},
      onEvent: (cb: (event: TranscriptEventInput) => void) => {
        channel.onEvent = cb;
        return () => {};
      },
      onDelta: (cb: (delta: TaggedTranscriptDelta) => void) => {
        channel.onDelta = cb;
        return () => {};
      },
      onError: () => () => {},
      destroy: () => {},
    }),
    postMessage: async () => {},
    interruptTurn: async () => {},
  };
});

beforeEach(() => {
  channel.onEvent = undefined;
  channel.onDelta = undefined;
  useSessionStore.setState({
    sessions: [
      { ...summary('s1'), projectId: 'p1', providerId: 'v1', modelId: 'm1' },
    ],
    currentSessionId: 's1',
  });
  useChatStore.setState({
    events: [],
    deltas: [],
    isGenerating: false,
    subagents: {},
    openSubagentId: null,
  });
});

describe('useChatAgent sub-agent routing wiring', () => {
  it('routes depth-0 frames to the main feed and tagged frames to the child bucket', () => {
    // Mounting the hook opens the channel for the current session and
    // registers the handlers under test.
    renderHook(() => useChatAgent());
    expect(channel.onEvent).toBeDefined();
    expect(channel.onDelta).toBeDefined();

    // 1. An untagged event belongs to the main conversation.
    act(() => {
      channel.onEvent!({
        time: 1,
        type: 'user_message',
        data: { content: 'go' },
      } as never);
    });
    expect(useChatStore.getState().events).toHaveLength(1);

    // 2. A tagged event and a tagged delta reach the child bucket and never
    //    the main buffers (the freeze regression gate, at wiring level).
    act(() => {
      channel.onEvent!({
        time: 2,
        type: 'model_call_start',
        data: { agentDepth: 1, childSessionId: 'w-sub-1' },
      } as never);
      channel.onDelta!({
        kind: 'text',
        text: 'chunk',
        agentDepth: 1,
        childSessionId: 'w-sub-1',
      });
    });
    const mid = useChatStore.getState();
    expect(mid.events).toHaveLength(1);
    expect(mid.deltas).toHaveLength(0);
    expect(mid.subagents['w-sub-1']!.events).toHaveLength(1);
    expect(mid.subagents['w-sub-1']!.deltas).toHaveLength(1);

    // 3. The subagent_finished bracket stays on the main feed (depth-0)
    //    and additionally closes the child's bucket.
    act(() => {
      channel.onEvent!({
        time: 3,
        type: 'subagent_finished',
        data: { childSessionId: 'w-sub-1', isError: false, durationMs: 42 },
      } as never);
    });
    const end = useChatStore.getState();
    expect(end.events).toHaveLength(2);
    expect(end.subagents['w-sub-1']!.status).toBe('done');
    expect(end.subagents['w-sub-1']!.durationMs).toBe(42);
  });
});
