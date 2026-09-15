// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useBackgroundTasks } from '@/hooks/use-background-tasks';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';

describe('useBackgroundTasks', () => {
  beforeEach(() => {
    useChatStore.setState({
      events: [],
      deltas: [],
      currentSessionId: 's1',
    });
    useSessionStore.setState({
      currentSessionId: 's1',
      sessions: [
        {
          id: 's1',
          title: 't',
          projectId: null,
          createdAt: 0,
          updatedAt: 0,
        } as never,
      ],
    });
  });

  it('returns empty when the live buffer has no subagent calls', () => {
    const { result } = renderHook(() => useBackgroundTasks());
    expect(result.current).toEqual([]);
  });

  // Wire shape aligned with the existing fixtures in
  // packages/core/src/__tests__/view-projection-views.test.ts
  // ("a running sub-agent (parked start, tool_call not yet flushed) links
  // its block"): assistant_message carries a tool_use block, and the
  // subagent_started bracket attaches childSessionId while the call is
  // still running (no tool_call / tool_result flushed yet).
  it('collects subagent tool_calls from the live projection', () => {
    useChatStore.setState({
      events: [
        {
          time: 1,
          type: 'turn_start',
          data: { turn: 1 },
          turn: 1,
        },
        {
          time: 2,
          type: 'model_call_start',
          data: { headerHash: 'h1' },
          turn: 1,
          step: 1,
        },
        {
          time: 3,
          type: 'assistant_message',
          data: {
            content: [
              {
                type: 'tool_use',
                id: 'c1',
                name: 'task',
                input: { message: 'hello world' },
              },
            ],
            stopReason: 'tool_use',
            durationMs: 10,
          },
          turn: 1,
          step: 1,
        },
        {
          time: 4,
          type: 'subagent_started',
          data: { childSessionId: 's1-sub-0', label: 'task', depth: 1 },
          turn: 1,
        },
      ] as never,
    });
    const { result } = renderHook(() => useBackgroundTasks());
    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      childSessionId: 's1-sub-0',
      title: 'hello world',
      status: 'running',
    });
  });
});
