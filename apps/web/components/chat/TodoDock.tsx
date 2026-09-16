'use client';

import { memo, useState } from 'react';
import { Check, ChevronDown, Circle, ListTodo, LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { countTodos, type TodoItem } from '@/lib/todos-model';

/** Max body height before the list scrolls (matches compact dock density). */
const MAX_BODY_HEIGHT = 160;

interface TodoDockProps {
  todos: readonly TodoItem[];
}

function StatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') {
    return (
      <span className="bg-success/15 text-success flex h-4 w-4 shrink-0 items-center justify-center rounded-full">
        <Check className="h-3 w-3" strokeWidth={2.5} />
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span className="text-primary flex h-4 w-4 shrink-0 items-center justify-center">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
      </span>
    );
  }
  return (
    <span className="text-muted-foreground/70 flex h-4 w-4 shrink-0 items-center justify-center">
      <Circle className="h-3 w-3" />
    </span>
  );
}

/**
 * Standing todo list dock — fixed above the composer, collapsible, capped
 * height with internal scroll. Empty list renders nothing.
 */
export const TodoDock = memo(function TodoDock({ todos }: TodoDockProps) {
  const [collapsed, setCollapsed] = useState(false);
  if (todos.length === 0) return null;

  const { completed, total } = countTodos(todos);

  return (
    <div
      data-testid="todo-dock"
      className="bg-card/80 mx-auto mb-2 w-full max-w-3xl overflow-hidden rounded-lg border shadow-sm"
    >
      <button
        type="button"
        className="hover:bg-muted/40 focus-visible:ring-ring flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors focus-visible:ring-1 focus-visible:outline-none"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? '展开任务列表' : '折叠任务列表'}
      >
        <ListTodo className="text-muted-foreground h-4 w-4 shrink-0" />
        <span className="text-foreground/90 font-medium">任务</span>
        <span className="text-muted-foreground text-xs">
          {completed} / {total} 已完成
        </span>
        <ChevronDown
          className={cn(
            'text-muted-foreground ml-auto h-4 w-4 shrink-0 transition-transform duration-150',
            collapsed && '-rotate-90',
          )}
        />
      </button>

      {!collapsed && (
        <div
          className="border-t px-2 pb-2"
          style={{ maxHeight: MAX_BODY_HEIGHT, overflowY: 'auto' }}
        >
          <ul className="divide-y divide-transparent">
            {todos.map((todo, i) => (
              <li
                key={`${i}-${todo.content}`}
                className="flex items-start gap-2 px-1 py-1.5"
              >
                <span className="mt-0.5">
                  <StatusIcon status={todo.status} />
                </span>
                <span
                  className={cn(
                    'text-foreground/90 min-w-0 flex-1 text-sm break-words',
                    todo.status === 'completed' && 'text-muted-foreground line-through',
                  )}
                >
                  {todo.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
});
