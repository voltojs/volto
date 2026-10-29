import { describe, expect, it } from 'vitest';
import { mergeTodoChanges, todoTransitionKey } from '../todo-feed';

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
