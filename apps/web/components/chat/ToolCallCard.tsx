'use client';

import { memo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CircleAlert, Check, LoaderCircle } from 'lucide-react';
import type { ConversationImage, ConversationToolCall } from '@voltojs/sdk/sse';
import { toolIcon } from '@/lib/tool-icon';
import { verificationBadge } from '@/lib/verification-badge';
import { toolCallFileRef } from '@voltojs/sdk/file-refs';
import { FileRefChip } from './FileRefChip';
import { TraceRow } from './TraceRow';
import { ToolResultImage } from './ToolResultImage';

interface ToolCallCardProps {
  call: ConversationToolCall;
  /** Project the call's content belongs to; null = unknown (no chips). */
  fileProjectId?: string | null;
  /**
   * One-line summary of the call (its command, path, query…), shown after the
   * tool name. Rows are indistinguishable without it — every `bash` call would
   * read the same.
   */
  label?: string;
  /** Session owning this call's attachments (screenshots need the store URL). */
  sessionId?: string | null;
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
    // The verdict arrives with the collected result; content comparison keeps
    // the memo honest across projection rebuilds.
    JSON.stringify(a.call.verification) === JSON.stringify(b.call.verification) &&
    a.call.approval?.decision === b.call.approval?.decision &&
    a.label === b.label &&
    a.fileProjectId === b.fileProjectId &&
    a.sessionId === b.sessionId &&
    JSON.stringify(a.call.images) === JSON.stringify(b.call.images)
  );
}

/** One tool call as a trace row; its body holds the arguments and the output. */
export const ToolCallCard = memo(function ToolCallCard({
  call,
  label,
  fileProjectId,
  sessionId,
}: ToolCallCardProps) {
  const t = useTranslations('chat');
  const failed = call.isError === true || call.approval?.decision === 'deny';
  // Failures open in both densities: a collapsed failure is a failure the user
  // has to hunt for. Controlled rather than `defaultOpen`, because in a live
  // run the card mounts while the tool is still running and the failure only
  // lands later. A user's collapse wins until the next failure.
  const summary = label !== undefined && label !== call.name ? label : undefined;
  // A collected background dispatch carries its acceptance verdict on the
  // task_output row; other tool calls never do.
  const verification =
    call.name === 'task_output' ? verificationBadge(t, call.verification) : undefined;
  const ref = toolCallFileRef(call.name, call.args);
  const images: ConversationImage[] = call.images ?? [];
  // A screenshot's value is the picture: open the result body as soon as it
  // lands instead of hiding it behind the row disclosure. A manual collapse
  // still wins (manualOpen below).
  const autoOpen = failed || images.length > 0;
  const renderDetail = () => {
    if (summary === undefined) return undefined;
    if (ref === null || fileProjectId === null) return summary;
    return (
      <FileRefChip target={ref} projectId={fileProjectId} variant="link" nested>
        {summary}
      </FileRefChip>
    );
  };
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
      detail={renderDetail()}
      {...(verification !== undefined
        ? {
            // A passed verdict is a quiet badge; a failed or unverifiable one
            // takes the amber warning slot with its reasons on hover, matching
            // SubagentCard's row vocabulary.
            ...(verification.warningDetail === undefined
              ? { badges: [verification.badge] }
              : {
                  warning: verification.badge,
                  warningDetail: verification.warningDetail,
                }),
          }
        : {})}
      meta={call.durationMs === undefined ? undefined : `${call.durationMs}ms`}
      status={<StatusIcon call={call} />}
      failed={failed}
      open={manualOpen ?? autoOpen}
      onOpenChange={setManualOpen}
      scrollable
    >
      <div>
        <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px] tracking-wide uppercase">
          {t('tool.params')}
        </div>
        <pre className="text-muted-foreground overflow-x-auto font-mono text-[11px] leading-relaxed">
          {JSON.stringify(call.args, null, 2)}
        </pre>
      </div>
      {call.result !== undefined && (
        <div>
          <div className="text-muted-foreground/50 mb-0.5 font-mono text-[10px] tracking-wide uppercase">
            {call.isError ? t('tool.failed') : t('tool.output')}
          </div>
          {/* The protocol carries the tool's real output — render it as text,
              never JSON.stringify'd metadata. */}
          <pre className="text-muted-foreground font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">
            {call.result}
          </pre>
          {images.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-2">
              {images.map((image) => (
                <ToolResultImage
                  key={image.attachmentId}
                  image={image}
                  sessionId={sessionId}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </TraceRow>
  );
}, toolCallCardComparator);
