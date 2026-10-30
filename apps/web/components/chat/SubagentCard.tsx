'use client';

import { memo, useEffect, useState } from 'react';
import { Bot, Check, CircleAlert, LoaderCircle } from 'lucide-react';
import type { ConversationToolCall } from '@volto/sdk/sse';
import { formatDuration } from '@/lib/trajectory-view-model';
import { subagentTaskTitle } from '@/lib/background-tasks';
import { TraceRow } from './TraceRow';

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
 * A delegation as a trace row: same anatomy as a tool call, but activating it
 * opens the child session instead of expanding a body.
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
    typeof call.durationMs === 'number' ? formatDuration(call.durationMs) : null;
  const title = subagentTaskTitle(call.args);

  return (
    <TraceRow
      icon={Bot}
      label="task"
      detail={title === '' ? undefined : title}
      meta={isRunning ? undefined : (duration ?? undefined)}
      failed={call.isError === true}
      status={
        isRunning ? (
          <span className="text-muted-foreground/40 flex items-center gap-1 font-mono text-[10px] tabular-nums">
            <LoaderCircle className="h-3 w-3 animate-spin" />
            {elapsed ?? undefined}
          </span>
        ) : call.isError ? (
          <CircleAlert className="text-destructive h-3 w-3" />
        ) : (
          <Check className="text-success/60 h-3 w-3" />
        )
      }
      onActivate={() => onOpenSubagent?.(call.childSessionId ?? '')}
      ariaLabel={`子智能体 ${title}`.trim()}
    />
  );
}, subagentCardComparator);
