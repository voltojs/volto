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
   * One-line summary of the call (its command, path, query…), shown after the
   * tool name. Rows are indistinguishable without it — every `bash` call would
   * read the same.
   */
  label?: string;
}

function StatusIcon({ call }: ToolCallCardProps) {
  if (call.result === undefined) {
    return <LoaderCircle className="text-muted-foreground/60 h-3 w-3 animate-spin" />;
  }
  return call.isError ? (
    <CircleAlert className="text-destructive h-3 w-3" />
  ) : (
    <Check className="text-success/60 h-3 w-3" />
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
    a.label === b.label
  );
}

/** Collapsed summary of one tool call, expandable to show args and output. */
export const ToolCallCard = memo(function ToolCallCard({
  call,
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
        // Header and body share one soft panel while open, so the row reads as
        // a single unit; the panel reaches into the chevron gutter so the body
        // text can line up with the header text.
        'group/tool -ml-5 w-[calc(100%+1.25rem)] rounded-md transition-colors',
        open && 'bg-muted/30',
      )}
    >
      {/* A log line, not a card: no frame, no surface, no padding box. The
          row reads as an annotation on the answer — mono label, muted summary,
          hairline duration — and only earns a background on hover, which is
          also the affordance that says "open me". */}
      <CollapsibleTrigger
        className={cn(
          // The chevron lives in the gutter so the row's text starts on the
          // same left edge as the prose above and below it.
          'group relative flex w-full items-center gap-1.5 rounded-md py-[2px] pr-1 pl-5',
          'text-left text-[13px] leading-[18px] transition-colors',
          'hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none',
        )}
      >
        <ChevronRight className="text-muted-foreground/40 absolute left-1 top-1/2 h-3 w-3 -translate-y-1/2 transition-transform duration-150 group-data-[panel-open]:rotate-90" />
        <span
          className={cn(
            'shrink-0 font-mono text-[11px]',
            failed ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {call.name}
        </span>
        {label !== undefined && label !== call.name && (
          <span className="text-muted-foreground/70 truncate">{label}</span>
        )}
        {typeof call.durationMs === 'number' && (
          <span className="text-muted-foreground/40 ml-auto shrink-0 font-mono text-[10px] tabular-nums">
            {call.durationMs}ms
          </span>
        )}
        <span className={cn('shrink-0', typeof call.durationMs === 'number' ? '' : 'ml-auto')}>
          <StatusIcon call={call} />
        </span>
      </CollapsibleTrigger>

      {denialNote && (
        <div className="text-muted-foreground/80 py-0.5 pl-5 pr-2 text-[11px]">{denialNote}</div>
      )}

      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
        <div className="space-y-1.5 pt-0.5 pr-2 pb-2 pl-5">
          <div>
            <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px] tracking-wide uppercase">
              参数
            </div>
            <pre className="text-muted-foreground overflow-x-auto font-mono text-[11px] leading-relaxed">
              {JSON.stringify(call.args, null, 2)}
            </pre>
          </div>
          {call.result !== undefined && (
            <div>
              <div
                className={cn(
                  'mb-0.5 font-mono text-[10px] tracking-wide uppercase',
                  call.isError ? 'text-destructive/70' : 'text-muted-foreground/50',
                )}
              >
                {call.isError ? '执行失败' : '输出'}
              </div>
              {/* The protocol carries the tool's real output — render it as
                  text, never JSON.stringify'd metadata. */}
              <pre
                className={cn(
                  'font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap',
                  call.isError ? 'text-destructive/80' : 'text-muted-foreground',
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
