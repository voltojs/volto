import { describe, it, expect } from 'vitest';
import { foldTodosFromEvents, countTodos } from '../todos-model';
import type { TranscriptEventInput } from '@voltojs/sdk/sse';

function todoEvent(todos: Array<{ content: string; status: string }>): TranscriptEventInput {
  return {
    type: 'todoListUpdated',
    time: 1,
    data: {
      todos,
      counts: { pending: 0, inProgress: 0, completed: 0 },
    },
  } as TranscriptEventInput;
}

describe('foldTodosFromEvents', () => {
  it('returns null when no todoListUpdated exists', () => {
    expect(
      foldTodosFromEvents([
        { type: 'turn_start', data: { turn: 1 }, time: 1 } as TranscriptEventInput,
      ]),
    ).toBeNull();
  });

  it('last write wins', () => {
    const todos = foldTodosFromEvents([
      todoEvent([{ content: 'a', status: 'pending' }]),
      { type: 'tool_result', data: {}, time: 2 } as TranscriptEventInput,
      todoEvent([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
      ]),
    ]);
    expect(todos).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ]);
  });

  it('empty array clears the dock source', () => {
    expect(
      foldTodosFromEvents([
        todoEvent([{ content: 'a', status: 'pending' }]),
        todoEvent([]),
      ]),
    ).toEqual([]);
  });

  it('ignores malformed payloads and keeps the previous list', () => {
    const todos = foldTodosFromEvents([
      todoEvent([{ content: 'keep', status: 'pending' }]),
      {
        type: 'todoListUpdated',
        time: 2,
        data: { todos: [{ content: 1, status: 'nope' }] },
      } as unknown as TranscriptEventInput,
    ]);
    expect(todos).toEqual([{ content: 'keep', status: 'pending' }]);
  });
});

describe('countTodos', () => {
  it('counts by status', () => {
    expect(
      countTodos([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' },
      ]),
    ).toEqual({ total: 3, completed: 1, inProgress: 1, pending: 1 });
  });
});
