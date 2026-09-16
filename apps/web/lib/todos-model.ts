import { foldStandingTodos } from '@volto/sdk/sse';
import type { TodoItem } from '@volto/sdk/sse';

export type { TodoItem };
export type TodoStatus = TodoItem['status'];

/** Re-export: latest valid `todoListUpdated` snapshot, or null when none. */
export const foldTodosFromEvents = foldStandingTodos;

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
