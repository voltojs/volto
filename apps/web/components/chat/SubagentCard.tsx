'use client';

import { memo, useEffect, useState } from 'react';
import { Bot, Check, CircleAlert, LoaderCircle } from 'lucide-react';
import type { ConversationToolCall } from '@volto/sdk/sse';
import { formatDuration } from '@/lib/trajectory-view-model';
import { subagentTaskTitle } from '@/lib/background-tasks';
import { cn } from '@/lib/utils';

interface SubagentCardProps {
  call: ConversationToolCall;
  onOpenSubagent?: (childSessionId: string) => void;
}

/**
 * Skip re-render unless something observable changed. `args` (and the call
 * object itself) churn identity on every projection rebuild while their
 * content is fixed for a given call, so identity comparison would defeat the
 * memo; compare only the fields that actually move during a live run —
 * result/isError/durationMs land together at tool_result. Excluded on
 * purpose: `args` (fresh reference per projection; the title derived from it
 * is fixed once the call is issued), `childSessionId`/`startedAt` (write-once
 * when the delegation bracket lands), `approval` (not rendered by this
 * component). Exported for the comparator test.
 */
export function subagentCardComparator(
  a: SubagentCardProps,
  b: SubagentCardProps,
): boolean {
  return (
    a.call.id === b.call.id &&
    a.call.result === b.call.result &&
    a.call.isError === b.call.isError &&
    a.call.durationMs === b.call.durationMs &&
    a.onOpenSubagent === b.onOpenSubagent
  );
}

/**
 * Compact single clickable row for a sub-agent delegation in the main
 * conversation (type + title + status). The whole row opens the sub-agent
 * pane; there is no collapsible body and no footer button — the plain
 * ToolCallCard keeps that job.
 */
export const SubagentCard = memo(function SubagentCard({
  call,
  onOpenSubagent,
}: SubagentCardProps) {
  // While the delegation is still running (no result yet) a live elapsed
  // counter ticks next to the spinner; once the result lands, durationMs
  // takes over and the interval is torn down.
  const isRunning = call.result === undefined;
  // Ticking clock for the running elapsed counter. `Date.now()` lives in the
  // interval — never in render — so each tick merely snapshots the current
  // time into state and elapsed derives from that snapshot.
  const [now, setNow] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isRunning]);
  const elapsed =
    isRunning && call.startedAt !== undefined && now !== undefined
      ? formatDuration(now - call.startedAt)
      : null;
  const duration =
    typeof call.durationMs === 'number'
      ? formatDuration(call.durationMs)
      : null;
  const title = subagentTaskTitle(call.args);

  return (
    <button
      type="button"
      onClick={() => onOpenSubagent?.(call.childSessionId!)}
      aria-label={`子智能体 ${title}`.trim()}
      className={cn(
        'bg-card/60 hover:bg-muted/60 flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs',
        call.isError && 'border-destructive/30 bg-destructive/5',
      )}
    >
      <Bot className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
      <span className="text-muted-foreground shrink-0">子智能体</span>
      <span className="text-primary shrink-0 font-mono">task</span>
      {title && (
        <>
          <span className="text-muted-foreground/70 shrink-0">·</span>
          <span className="truncate">{title}</span>
        </>
      )}
      <span className="text-muted-foreground/70 ml-auto flex shrink-0 items-center gap-1 font-mono text-[10px]">
        {isRunning ? (
          <>
            <LoaderCircle className="h-3 w-3 animate-spin" />
            <span>运行中</span>
            {elapsed && <span>{elapsed}</span>}
          </>
        ) : (
          <>
            {call.isError ? (
              <CircleAlert className="text-destructive h-3 w-3" />
            ) : (
              <Check className="text-success h-3 w-3" />
            )}
            {duration && <span>{duration}</span>}
          </>
        )}
      </span>
    </button>
  );
}, subagentCardComparator);
