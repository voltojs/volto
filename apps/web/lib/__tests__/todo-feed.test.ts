import { describe, expect, it } from 'vitest';
import {
  foldMergedTodoTransitions,
  mergeTodoChanges,
  todoTransitionKey,
} from '../todo-feed';

const row = (time: number, kind: 'completed' | 'added', content: string, turn = 1) => ({
  turn,
  time,
  transition: { kind, content } as const,
});

describe('mergeTodoChanges', () => {
  it('derives a stable key without seq', () => {
    expect(todoTransitionKey(row(120, 'completed', 'a'))).toBe('1:120:completed:a');
  });

  it('dedupes stored against live and keeps one row per change', () => {
    const merged = mergeTodoChanges(
      [row(100, 'added', 'a')],
      [row(100, 'added', 'a'), row(200, 'completed', 'a')],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((r) => r.time)).toEqual([100, 200]);
  });

  it('sorts by time and is stable on ties', () => {
    const merged = mergeTodoChanges(undefined, [
      row(200, 'completed', 'b'),
      row(200, 'completed', 'a'),
      row(100, 'added', 'z'),
    ]);
    expect(merged.map((r) => r.key)).toEqual([
      '1:100:added:z',
      '1:200:completed:b',
      '1:200:completed:a',
    ]);
  });
});

describe('foldMergedTodoTransitions', () => {
  const snap = (time: number, todos: Array<{ content: string; status: string }>) => ({
    type: 'todoListUpdated',
    data: { todos },
    time,
    turn: 1,
  });
  const pending = [{ content: 'a', status: 'pending' }];
  const done = [{ content: 'a', status: 'completed' }];

  it('does not replay stored events that the live buffer repeats', () => {
    // The live buffer starts before the fetch cut-off, so it repeats events
    // the stored snapshot already covers. Replaying them after the newer
    // snapshots would read as "reopened"/"removed" — false reverse progress.
    // Exactly one row survives: the real completion recorded in stored.
    const stored = [snap(100, pending), snap(200, done)];
    const live = [snap(100, pending), snap(200, done)];
    expect(foldMergedTodoTransitions(stored, live)).toEqual([
      { turn: 1, time: 200, transition: { kind: 'completed', content: 'a' } },
    ]);
  });

  it('keeps transitions that happen after the cut-off', () => {
    const stored = [snap(100, pending), snap(200, done)];
    const live = [
      snap(200, done),
      snap(300, [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
      ]),
    ];
    // The stored history contributes its own completion; only the repeated
    // tail is dropped, and the post-cut-off snapshot contributes both lines.
    expect(foldMergedTodoTransitions(stored, live).map((r) => r.transition.kind)).toEqual([
      'completed',
      'started',
      'added',
    ]);
  });

  it('folds the live stream alone when nothing is stored yet', () => {
    expect(foldMergedTodoTransitions([], [snap(100, pending)]).length).toBe(0);
  });
});
