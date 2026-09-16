import { describe, it, expect } from 'vitest';
import { foldStandingTodos } from '../todo-format.js';
import type { TodoItem } from '../state.js';

function todoEvent(todos: TodoItem[]): { type: string; data: unknown } {
  return {
    type: 'todoListUpdated',
    data: { todos, counts: { pending: 0, inProgress: 0, completed: 0 } },
  };
}

describe('foldStandingTodos', () => {
  it('returns null when no todoListUpdated exists', () => {
    expect(foldStandingTodos([{ type: 'turn_start', data: { turn: 1 } }])).toBeNull();
  });

  it('last valid write wins', () => {
    const todos = foldStandingTodos([
      todoEvent([{ content: 'a', status: 'pending' }]),
      { type: 'tool_result', data: {} },
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

  it('empty array is a valid clear', () => {
    expect(
      foldStandingTodos([
        todoEvent([{ content: 'a', status: 'pending' }]),
        todoEvent([]),
      ]),
    ).toEqual([]);
  });

  it('ignores malformed snapshots and keeps the previous list', () => {
    const todos = foldStandingTodos([
      todoEvent([{ content: 'keep', status: 'pending' }]),
      { type: 'todoListUpdated', data: { todos: [{ content: 1, status: 'nope' }] } },
    ]);
    expect(todos).toEqual([{ content: 'keep', status: 'pending' }]);
  });
});
