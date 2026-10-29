'use client';

import { memo } from 'react';
import { ChevronRight, CircleAlert, Check, LoaderCircle } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import type { ConversationToolCall } from '@volto/sdk/sse';
import { denialNoteFor } from '@/lib/approvals';
import { cn } from '@/lib/utils';

interface ToolCallCardProps {
  call: ConversationToolCall;
  /**
   * One-line trigger (concise density): the summary label replaces the bare
   * tool name and args stay collapsed until opened.
   */
  compact?: boolean;
  /** Pre-computed one-line label; ignored unless `compact`. */
  label?: string;
}

function StatusIcon({ call }: ToolCallCardProps) {
  if (call.result === undefined) {
    return (
      <LoaderCircle className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
    );
  }
  return call.isError ? (
    <CircleAlert className="text-destructive h-3.5 w-3.5" />
  ) : (
    <Check className="text-success h-3.5 w-3.5" />
  );
}

/**
 * Skip re-render unless something observable changed. `args` (and the call
 * object itself) churn identity on every projection rebuild while their
 * content is fixed for a given call, so identity comparison would defeat the
 * memo; compare only the fields that actually move during a live run —
 * result/isError land together at tool_result, approval decision at
 * approval_decision. Exported for the comparator test.
 */
export function toolCallCardComparator(
  a: ToolCallCardProps,
  b: ToolCallCardProps,
): boolean {
  return (
    a.call.id === b.call.id &&
    a.call.result === b.call.result &&
    a.call.isError === b.call.isError &&
    a.call.approval?.decision === b.call.approval?.decision &&
    a.compact === b.compact &&
    a.label === b.label
  );
}

/** Collapsed summary of one tool call, expandable to show args and output. */
export const ToolCallCard = memo(function ToolCallCard({
  call,
  compact = false,
  label,
}: ToolCallCardProps) {
  // Settled-approval rendering. The pending `ApprovalCard` vanishes the
  // moment a decision lands; without this line a fail-closed denial
  // (connection lost, turn interrupted) would look identical to a click the
  // user made — or to a silent disappearance.
  const denialNote =
    call.approval?.decision === 'deny'
      ? denialNoteFor(call.approval.reason)
      : null;

  // Failures open by default in BOTH densities: a collapsed failure is a
  // failure the user has to hunt for. Still collapsible — this is a default,
  // not a lock.
  const failed = call.isError === true || call.approval?.decision === 'deny';

  return (
    <Collapsible
      defaultOpen={failed}
      className={cn(
        'bg-card/60 overflow-hidden rounded-md border text-xs',
        call.isError && 'border-destructive/30 bg-destructive/5',
      )}
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <ChevronRight className="text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-data-[panel-open]:rotate-90" />
        <span className="text-foreground/90 truncate font-mono">
          {compact ? (label ?? call.name) : call.name}
        </span>
        {typeof call.durationMs === 'number' && (
          <span className="text-muted-foreground/70 font-mono text-[10px]">
            · {call.durationMs}ms
          </span>
        )}
        <span className="ml-auto shrink-0">
          <StatusIcon call={call} />
        </span>
      </CollapsibleTrigger>

      {denialNote && (
        <div className="text-muted-foreground border-t px-2.5 py-1.5 text-[11px]">
          {denialNote}
        </div>
      )}

      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
        <div className="space-y-2 border-t px-2.5 py-2">
          <div>
            <div className="text-muted-foreground mb-1 font-mono text-[10px] tracking-wide uppercase">
              参数
            </div>
            <pre className="bg-muted/60 text-foreground/80 overflow-x-auto rounded p-2 font-mono">
              {JSON.stringify(call.args, null, 2)}
            </pre>
          </div>
          {call.result !== undefined && (
            <div>
              <div
                className={cn(
                  'mb-1 font-mono text-[10px] tracking-wide uppercase',
                  call.isError ? 'text-destructive' : 'text-success',
                )}
              >
                {call.isError ? '✕ 执行失败' : '✓ 执行成功'}
              </div>
              {/* The protocol carries the tool's real output — render it as
                  text, never JSON.stringify'd metadata. */}
              <pre
                className={cn(
                  'rounded p-2 font-mono text-[11px] break-words whitespace-pre-wrap',
                  call.isError
                    ? 'text-destructive/90 bg-destructive/5'
                    : 'text-foreground/80 bg-muted/40',
                )}
              >
                {call.result}
              </pre>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}, toolCallCardComparator);
