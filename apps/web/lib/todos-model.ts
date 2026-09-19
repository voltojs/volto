import { foldStandingTodos } from '@volto/sdk/sse';
import type { TodoItem, TranscriptEventInput } from '@volto/sdk/sse';

export type { TodoItem };
export type TodoStatus = TodoItem['status'];

/** Re-export: latest valid `todoListUpdated` snapshot, or null when none. */
export const foldTodosFromEvents = foldStandingTodos;

/**
 * The newest `turn_end` event in the main buffer, or null when the buffer
 * holds none. Scans from the tail, so the cost is one turn's worth of events.
 * Used as a "a turn just ended" signal: the events array is appended
 * immutably and event objects keep their identity, so the returned reference
 * is stable across unrelated event pushes — it changes exactly when a new
 * turn closes (or the buffer is reset on session switch), which is what a
 * re-check effect (e.g. the plan tab's auto-refresh) wants to key on.
 */
export function selectLastTurnEnd(
  events: readonly TranscriptEventInput[],
): TranscriptEventInput | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === 'turn_end') return event;
  }
  return null;
}

export function countTodos(todos: readonly TodoItem[]): {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
} {
  let completed = 0;
  let inProgress = 0;
  let pending = 0;
  for (const t of todos) {
    if (t.status === 'completed') completed++;
    else if (t.status === 'in_progress') inProgress++;
    else pending++;
  }
  return { total: todos.length, completed, inProgress, pending };
}
