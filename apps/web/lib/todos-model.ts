import type { TranscriptEventInput } from '@volto/sdk/sse';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed';
}

function parseTodos(data: Record<string, unknown>): TodoItem[] | null {
  const raw = data['todos'];
  if (!Array.isArray(raw)) return null;
  const todos: TodoItem[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const content = (item as { content?: unknown }).content;
    const status = (item as { status?: unknown }).status;
    if (typeof content !== 'string' || !isTodoStatus(status)) return null;
    todos.push({ content, status });
  }
  return todos;
}

/**
 * Standing plan = latest `todoListUpdated` snapshot in the durable event log.
 * Last-write-wins; `null` when the session has never written a list.
 */
export function foldTodosFromEvents(
  events: readonly TranscriptEventInput[],
): TodoItem[] | null {
  let todos: TodoItem[] | null = null;
  for (const event of events) {
    if (event.type !== 'todoListUpdated') continue;
    const parsed = parseTodos(event.data as Record<string, unknown>);
    if (parsed) todos = parsed;
  }
  return todos;
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
