// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSubagentChatAgent } from '@/hooks/use-subagent-chat-agent';
import { useChatStore } from '@/stores/chat-store';

/**
 * Shared mock-client wiring. The shape mirrors `createGatewaySSEClient`'s
 * real return value (packages/sdk/src/sse/client.ts) so a missing method
 * fails here rather than in the browser.
 */
const agentConfig = vi.hoisted(() => {
  const state = {
    eventHandlers: [] as Array<(event: unknown) => void>,
    deltaHandlers: [] as Array<(delta: unknown) => void>,
    errorHandlers: [] as Array<(data: unknown) => void>,
    stateHandlers: [] as Array<(s: string) => void>,
    lastClient: null as null | {
      connect: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    },
  };

  const postMessage = vi.fn(async () => {});
  const interruptTurn = vi.fn(async () => true);

  const createGatewaySSEClient = vi.fn(() => {
    const client = {
      connect: vi.fn(() => {
        // Simulate the real client's open handshake so the hook's ready
        // promise can resolve without a live gateway.
        for (const handler of [...state.stateHandlers]) handler('connected');
      }),
      disconnect: vi.fn(),
      onEvent: vi.fn((handler: (event: unknown) => void) => {
        state.eventHandlers.push(handler);
        return () => {
          state.eventHandlers = state.eventHandlers.filter((h) => h !== handler);
        };
      }),
      onDelta: vi.fn((handler: (delta: unknown) => void) => {
        state.deltaHandlers.push(handler);
        return () => {
          state.deltaHandlers = state.deltaHandlers.filter((h) => h !== handler);
        };
      }),
      onError: vi.fn((handler: (data: unknown) => void) => {
        state.errorHandlers.push(handler);
        return () => {
          state.errorHandlers = state.errorHandlers.filter((h) => h !== handler);
        };
      }),
      onStateChange: vi.fn((handler: (s: string) => void) => {
        state.stateHandlers.push(handler);
        return () => {
          state.stateHandlers = state.stateHandlers.filter((h) => h !== handler);
        };
      }),
      getState: vi.fn(() => 'connected'),
      getLastEventId: vi.fn(() => ''),
      getConnectionToken: vi.fn(() => null),
      setEventSourceFactory: vi.fn(),
      destroy: vi.fn(),
    };
    state.lastClient = client;
    return client;
  });

  const eventsUrl = (id: string) =>
    `/gateway/events?sessionId=${encodeURIComponent(id)}`;

  return { state, postMessage, interruptTurn, createGatewaySSEClient, eventsUrl };
});

vi.mock('@/lib/agent-config', () => ({
  createGatewaySSEClient: agentConfig.createGatewaySSEClient,
  eventsUrl: agentConfig.eventsUrl,
  postMessage: agentConfig.postMessage,
  interruptTurn: agentConfig.interruptTurn,
}));

const TURN_END = {
  time: 1,
  type: 'turn_end',
  data: { turn: 1, reason: 'end_turn' },
};

describe('useSubagentChatAgent', () => {
  const config = {
    projectId: 'p1',
    providerId: 'v1',
    modelId: 'm1',
    permissionMode: 'ask',
    reasoningEffort: 'high',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    agentConfig.state.eventHandlers = [];
    agentConfig.state.deltaHandlers = [];
    agentConfig.state.errorHandlers = [];
    agentConfig.state.stateHandlers = [];
    agentConfig.state.lastClient = null;
    agentConfig.interruptTurn.mockResolvedValue(true);
    agentConfig.postMessage.mockResolvedValue(undefined);
    useChatStore.setState({
      subagents: {},
      isGenerating: false,
      events: [],
      deltas: [],
    });
  });

  it('posts merged config and sets subagent generating without touching global isGenerating', async () => {
    const { result } = renderHook(() =>
      useSubagentChatAgent({ childSessionId: 'c1', config }),
    );
    await result.current.sendMessage('hi', { modelId: 'm2' });
    expect(agentConfig.postMessage).toHaveBeenCalledWith('c1', 'hi', {
      projectId: 'p1',
      providerId: 'v1',
      modelId: 'm2',
      permissionMode: 'ask',
      reasoningEffort: 'high',
    });
    expect(useChatStore.getState().subagents.c1?.isGenerating).toBe(true);
    expect(useChatStore.getState().isGenerating).toBe(false);
  });

  it('refuses to send while the child bucket is running', async () => {
    useChatStore.setState({
      subagents: { c1: { events: [], deltas: [], status: 'running' } },
    });
    const { result } = renderHook(() =>
      useSubagentChatAgent({ childSessionId: 'c1', config }),
    );
    await result.current.sendMessage('hi');
    expect(agentConfig.postMessage).not.toHaveBeenCalled();
  });

  it('refuses to send while a continued turn is still generating', async () => {
    useChatStore.setState({
      subagents: {
        c1: { events: [], deltas: [], status: 'done', isGenerating: true },
      },
    });
    const { result } = renderHook(() =>
      useSubagentChatAgent({ childSessionId: 'c1', config }),
    );
    await result.current.sendMessage('hi');
    expect(agentConfig.postMessage).not.toHaveBeenCalled();
  });

  it('clears subagent generating on turn_end and exposes isGenerating', async () => {
    const { result } = renderHook(() =>
      useSubagentChatAgent({ childSessionId: 'c1', config }),
    );
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    expect(result.current.isGenerating).toBe(true);
    expect(useChatStore.getState().subagents.c1?.isGenerating).toBe(true);

    await act(async () => {
      for (const handler of agentConfig.state.eventHandlers) handler(TURN_END);
    });
    expect(useChatStore.getState().subagents.c1?.isGenerating).toBe(false);
    expect(result.current.isGenerating).toBe(false);
  });

  it('clears subagent generating and surfaces an error when postMessage fails', async () => {
    agentConfig.postMessage.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() =>
      useSubagentChatAgent({ childSessionId: 'c1', config }),
    );
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    expect(useChatStore.getState().subagents.c1?.isGenerating).toBe(false);
    expect(result.current.isGenerating).toBe(false);
    const events = useChatStore.getState().subagents.c1?.events ?? [];
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(useChatStore.getState().isGenerating).toBe(false);
  });

  it('clears subagent generating on a pre-stream error frame', async () => {
    const { result } = renderHook(() =>
      useSubagentChatAgent({ childSessionId: 'c1', config }),
    );
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    expect(useChatStore.getState().subagents.c1?.isGenerating).toBe(true);

    await act(async () => {
      for (const handler of agentConfig.state.errorHandlers) {
        handler({ code: 'BUSY', message: 'session busy' });
      }
    });
    expect(useChatStore.getState().subagents.c1?.isGenerating).toBe(false);
    const events = useChatStore.getState().subagents.c1?.events ?? [];
    expect(
      events.some(
        (e) =>
          e.type === 'error' &&
          (e.data as { message?: string }).message === 'session busy',
      ),
    ).toBe(true);
  });

  it('clears subagent generating when interrupt reports nothing running (409)', async () => {
    agentConfig.interruptTurn.mockResolvedValue(false);
    useChatStore.setState({
      subagents: {
        c1: { events: [], deltas: [], status: 'done', isGenerating: true },
      },
    });
    const { result } = renderHook(() =>
      useSubagentChatAgent({ childSessionId: 'c1', config }),
    );
    await act(async () => {
      await result.current.stopGeneration();
    });
    expect(agentConfig.interruptTurn).toHaveBeenCalledWith('c1');
    expect(useChatStore.getState().subagents.c1?.isGenerating).toBe(false);
  });

  it('leaves generating set when interrupt succeeds — turn_end releases it', async () => {
    useChatStore.setState({
      subagents: {
        c1: { events: [], deltas: [], status: 'done', isGenerating: true },
      },
    });
    const { result } = renderHook(() =>
      useSubagentChatAgent({ childSessionId: 'c1', config }),
    );
    await act(async () => {
      await result.current.stopGeneration();
    });
    expect(useChatStore.getState().subagents.c1?.isGenerating).toBe(true);
  });

  it('opens the child SSE channel and routes tagged frames into the bucket', async () => {
    const { result } = renderHook(() =>
      useSubagentChatAgent({ childSessionId: 'c1', config }),
    );
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    expect(agentConfig.createGatewaySSEClient).toHaveBeenCalledWith(
      '/gateway/events?sessionId=c1',
    );
    expect(agentConfig.state.lastClient?.connect).toHaveBeenCalled();

    await act(async () => {
      for (const handler of agentConfig.state.eventHandlers) {
        handler({
          time: 2,
          type: 'assistant_message',
          turn: 1,
          step: 1,
          data: {
            content: [{ type: 'text', text: 'hello' }],
            stopReason: 'end_turn',
            durationMs: 5,
            // Tagged as this child's traffic.
          },
          agentDepth: 1,
          childSessionId: 'c1',
        });
      }
    });
    const bucket = useChatStore.getState().subagents.c1;
    expect(bucket?.events.some((e) => e.type === 'assistant_message')).toBe(
      true,
    );
  });

  it('does nothing without a childSessionId or with an incomplete config', async () => {
    const { result: noChild } = renderHook(() =>
      useSubagentChatAgent({ childSessionId: null, config }),
    );
    await noChild.current.sendMessage('hi');
    expect(agentConfig.postMessage).not.toHaveBeenCalled();

    const { result: badConfig } = renderHook(() =>
      useSubagentChatAgent({
        childSessionId: 'c1',
        config: { projectId: null, providerId: null, modelId: null },
      }),
    );
    await badConfig.current.sendMessage('hi');
    expect(agentConfig.postMessage).not.toHaveBeenCalled();
  });
});
