/**
 * Wiring-level regression gate for the generating-state flag.
 *
 * `isGenerating` must follow the turn frames the gateway actually sends,
 * not just the local send. The gateway's settle-time auto-flush starts a
 * full turn on its own after the previous `turn_end`; a client that only
 * sets the flag inside `sendMessage` renders that turn as idle (no Stop
 * button, and `stopGeneration` early-returns). Mounting the hook opens the
 * channel, then the test drives `channel.onEvent` directly — it never calls
 * `sendMessage`, so only a `turn_start` handler can flip the flag.
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
} from '@voltojs/sdk/sse';

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
    // Same fixture as use-chat-agent-routing.test.tsx: capture the hook's
    // onEvent/onDelta handlers so the test can emit frames through them.
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
    notices: [],
  });
});

describe('useChatAgent generating state', () => {
  it('shows generating for a server-initiated turn it never sent', () => {
    // Mounting opens the channel for the current session.
    renderHook(() => useChatAgent());
    expect(channel.onEvent).toBeDefined();
    expect(useChatStore.getState().isGenerating).toBe(false);

    // The gateway's auto-flush begins the next turn on its own: no local
    // sendMessage ever ran for it, so the frame itself must flip the flag.
    act(() => {
      channel.onEvent!({
        time: 1,
        type: 'turn_start',
        data: { turn: 2 },
      } as TranscriptEventInput);
    });
    expect(useChatStore.getState().isGenerating).toBe(true);

    // The frame that closes any turn still releases the flag.
    act(() => {
      channel.onEvent!({
        time: 2,
        type: 'turn_end',
        data: { reason: 'done' },
      } as TranscriptEventInput);
    });
    expect(useChatStore.getState().isGenerating).toBe(false);
  });
});
