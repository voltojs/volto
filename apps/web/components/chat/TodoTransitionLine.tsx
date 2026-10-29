'use client';

import { Check, CirclePlus, CircleMinus, Play, RotateCcw } from 'lucide-react';
import type { TodoTransition, TodoTransitionKind } from '@volto/sdk/sse';
import { cn } from '@/lib/utils';

const VERB: Record<TodoTransitionKind, string> = {
  started: '开始',
  completed: '完成',
  reopened: '重新打开',
  added: '新增',
  removed: '移除',
};

const ICON: Record<TodoTransitionKind, typeof Check> = {
  started: Play,
  completed: Check,
  reopened: RotateCcw,
  added: CirclePlus,
  removed: CircleMinus,
};

/**
 * One todo status change, rendered as a light progress line in the chat feed.
 *
 * Deliberately not a card: these lines are the "is it moving?" signal, and a
 * turn can produce a dozen of them. The dock above the composer keeps the
 * standing plan; this only records what changed and when.
 */
export function TodoTransitionLine({ transition }: { transition: TodoTransition }) {
  const Icon = ICON[transition.kind];
  const muted = transition.kind === 'added' || transition.kind === 'removed';
  return (
    <div className="flex items-start gap-1.5 px-0.5 text-xs">
      <Icon
        className={cn(
          'mt-0.5 h-3 w-3 shrink-0',
          transition.kind === 'completed' && 'text-success',
          muted && 'text-muted-foreground/70',
          !muted && transition.kind !== 'completed' && 'text-primary',
        )}
      />
      <span className={cn('shrink-0', muted ? 'text-muted-foreground' : 'text-foreground/80')}>
        {VERB[transition.kind]}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 break-words',
          transition.kind === 'completed'
            ? 'text-muted-foreground line-through'
            : 'text-foreground/90',
        )}
      >
        {transition.content}
      </span>
    </div>
  );
}
