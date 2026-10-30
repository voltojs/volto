'use client';

import { memo, useState } from 'react';
import { CircleAlert, Check, LoaderCircle } from 'lucide-react';
import type { ConversationToolCall } from '@volto/sdk/sse';
import { toolIcon } from '@/lib/tool-icon';
import { TraceRow } from './TraceRow';

interface ToolCallCardProps {
  call: ConversationToolCall;
  /**
   * One-line summary of the call (its command, path, query…), shown after the
   * tool name. Rows are indistinguishable without it — every `bash` call would
   * read the same.
   */
  label?: string;
}

function StatusIcon({ call }: { call: ConversationToolCall }) {
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

/** One tool call as a trace row; its body holds the arguments and the output. */
export const ToolCallCard = memo(function ToolCallCard({
  call,
  label,
}: ToolCallCardProps) {
  const failed = call.isError === true || call.approval?.decision === 'deny';
  // Failures open in both densities: a collapsed failure is a failure the user
  // has to hunt for. Controlled rather than `defaultOpen`, because in a live
  // run the card mounts while the tool is still running and the failure only
  // lands later. A user's collapse wins until the next failure.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const [lastFailed, setLastFailed] = useState(failed);
  if (failed !== lastFailed) {
    setLastFailed(failed);
    if (failed) setManualOpen(null);
  }

  return (
    <TraceRow
      icon={toolIcon(call.name)}
      label={call.name}
      detail={label !== undefined && label !== call.name ? label : undefined}
      meta={call.durationMs === undefined ? undefined : `${call.durationMs}ms`}
      status={<StatusIcon call={call} />}
      failed={failed}
      open={manualOpen ?? failed}
      onOpenChange={setManualOpen}
      scrollable
    >
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
          <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px] tracking-wide uppercase">
            {call.isError ? '执行失败' : '输出'}
          </div>
          {/* The protocol carries the tool's real output — render it as text,
              never JSON.stringify'd metadata. */}
          <pre className="text-muted-foreground font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">
            {call.result}
          </pre>
        </div>
      )}
    </TraceRow>
  );
}, toolCallCardComparator);
