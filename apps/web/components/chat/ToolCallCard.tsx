'use client';

import { memo, useState } from 'react';
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

  // Failures open in BOTH densities: a collapsed failure is a failure the
  // user has to hunt for. Controlled rather than `defaultOpen`, because in a
  // live run the card mounts while the tool is still running and the failure
  // only lands later — an uncontrolled default would keep it shut. Manual
  // collapse stays allowed: the effect fires only when `failed` flips.
  const failed = call.isError === true || call.approval?.decision === 'deny';
  // `manualOpen` is null until the user touches the trigger, so the panel
  // follows `failed` on its own — a failure that lands after mount opens the
  // card without an effect. A user's collapse wins until the next failure.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const [lastFailed, setLastFailed] = useState(failed);
  if (failed !== lastFailed) {
    setLastFailed(failed);
    if (failed) setManualOpen(null);
  }
  const open = manualOpen ?? failed;

  return (
    <Collapsible
      open={open}
      onOpenChange={setManualOpen}
      className={cn(
        'bg-card/60 overflow-hidden rounded-md border text-xs',
        call.isError && 'border-destructive/30 bg-destructive/5',
      )}
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <ChevronRight className="text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-data-[panel-open]:rotate-90" />
        {compact && label !== undefined ? (
          <>
            <span className="text-foreground/90 shrink-0 font-mono">{call.name}</span>
            <span className="text-muted-foreground/70 shrink-0">·</span>
            <span className="truncate">{label}</span>
          </>
        ) : (
          <span className="text-foreground/90 truncate font-mono">{call.name}</span>
        )}
        {typeof call.durationMs === 'number' && (
          <span className="text-muted-foreground/70 font-mono text-[10px]">
            · {call.durationMs}ms
          </span>
        )}
        <span className="ml-auto shrink-0">
          <StatusIcon call={call} />
        </span>
      </CollapsibleTrigger>

      {/* The failure fact must survive collapsing. Shown only while closed:
          open, the body already carries the same text, and printing it twice
          reads like two separate failures. */}
      {failed && compact && !open && call.result !== undefined && (
        <div
          data-testid="tool-error-summary"
          className="text-destructive/90 border-t px-2.5 py-1 font-mono text-[11px] break-words"
        >
          {firstLineClipped(call.result)}
        </div>
      )}

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


/** First line of a tool's output, clipped to a readable length. */
function firstLineClipped(text: string): string {
  const line = (text.split('\n')[0] ?? '').trim();
  const points = Array.from(line);
  return points.length <= 120 ? line : `${points.slice(0, 119).join('')}…`;
}
