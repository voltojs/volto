import { describe, it, expect } from 'vitest';
import { buildTurnRecords, toConversationView } from '@volto/sdk/sse';
import type { ConversationView, TranscriptEvent } from '@volto/sdk/sse';
import {
  collectBackgroundTasks,
  subagentTaskTitle,
} from '@/lib/background-tasks';

function viewWithCalls(
  calls: Array<Record<string, unknown>>,
): ConversationView {
  return {
    messages: [
      {
        id: 'm1',
        role: 'assistant',
        timestamp: 1,
        content: '',
        blocks: calls.map((call) => ({
          type: 'tool_call' as const,
          call: { name: 'task', args: {}, ...call } as never,
        })),
      },
    ],
  };
}

describe('subagentTaskTitle', () => {
  it('returns the first line of args.message and truncates at 80 chars', () => {
    expect(
      subagentTaskTitle({ message: 'line one\nline two' }),
    ).toBe('line one');
    const long = 'x'.repeat(90);
    expect(subagentTaskTitle({ message: long })).toBe(`${'x'.repeat(80)}…`);
  });

  it('returns empty string when message is not a string', () => {
    expect(subagentTaskTitle({ message: 42 })).toBe('');
    expect(subagentTaskTitle({})).toBe('');
  });
});

describe('collectBackgroundTasks', () => {
  it('collects only tool_calls with childSessionId', () => {
    const items = collectBackgroundTasks(
      viewWithCalls([
        { id: 'c1', childSessionId: 's-sub-0', args: { message: 'explore' }, startedAt: 100 },
        { id: 'c2', name: 'read_file', args: {}, result: 'ok' },
      ]),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'c1',
      childSessionId: 's-sub-0',
      title: 'explore',
      status: 'running',
      startedAt: 100,
    });
  });

  it('shows a dispatch while it is still running, before its result lands', () => {
    const events = [
      { time: 100, type: 'turn_start', data: { turn: 1 }, turn: 1 },
      {
        time: 105,
        type: 'assistant_message',
        data: {
          content: [{ type: 'tool_use', id: 'c1', name: 'task', input: { message: 'go' } }],
          durationMs: 1,
        },
        turn: 1,
        step: 1,
      },
      { time: 110, type: 'tool_call', data: { callId: 'c1', name: 'task', input: { message: 'go' } }, turn: 1, step: 1 },
      {
        time: 111,
        type: 'subagent_started',
        data: { childSessionId: 'child-1', label: 'explore', depth: 1, taskId: 't1' },
        turn: 1,
        step: 1,
      },
    ] as unknown as TranscriptEvent[];
    const items = collectBackgroundTasks(toConversationView(buildTurnRecords(events)));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      childSessionId: 'child-1',
      status: 'running',
    });
  });

  it('maps result / isError to done / error', () => {
    const items = collectBackgroundTasks(
      viewWithCalls([
        { id: 'c1', childSessionId: 'a', result: 'ok', durationMs: 10, startedAt: 1 },
        { id: 'c2', childSessionId: 'b', result: 'boom', isError: true, durationMs: 20, startedAt: 2 },
      ]),
    );
    expect(items.find((i) => i.id === 'c1')?.status).toBe('done');
    expect(items.find((i) => i.id === 'c2')?.status).toBe('error');
  });

  it('sorts by startedAt desc, missing startedAt last', () => {
    const items = collectBackgroundTasks(
      viewWithCalls([
        { id: 'old', childSessionId: 'a', startedAt: 10, result: 'ok' },
        { id: 'new', childSessionId: 'b', startedAt: 30, result: 'ok' },
        { id: 'none', childSessionId: 'c', result: 'ok' },
      ]),
    );
    expect(items.map((i) => i.id)).toEqual(['new', 'old', 'none']);
  });
});
