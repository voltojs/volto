'use client';

import { memo, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, Check, CircleAlert, LoaderCircle } from 'lucide-react';
import type { ConversationToolCall } from '@voltojs/sdk/sse';
import { formatDuration } from '@/lib/trajectory-view-model';
import { subagentTaskTitle, subagentTypeOf } from '@/lib/background-tasks';
import { verificationBadge } from '@/lib/verification-badge';
import { TraceRow } from './TraceRow';

/** Dispatch facts the pane needs to label its tab before the child loads. */
export interface SubagentOpenMeta {
  title?: string;
  agentType?: string;
}

interface SubagentCardProps {
  call: ConversationToolCall;
  onOpenSubagent?: (childSessionId: string, meta?: SubagentOpenMeta) => void;
}

/**
 * Skip re-render unless something observable changed. `args` (and the call
 * object itself) churn identity on every projection rebuild while their
 * content is fixed for a given call, so identity comparison would defeat the
 * memo; compare only the fields that actually move during a live run —
 * result/isError/durationMs land together at tool_result. Excluded on
 * purpose: `args` (fresh reference per projection; the title derived from it
 * is fixed once the call is issued), `childSessionId`/`startedAt`/`subagentTitle`
 * (write-once when the delegation bracket lands), `approval` (not rendered by
 * this component). Exported for the comparator test.
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
    // Write-once when the delegation bracket lands, exactly like
    // childSessionId: a title arriving after the first paint must re-render.
    a.call.subagentTitle === b.call.subagentTitle &&
    // Arrays are rebuilt per projection pass; compare their content, not
    // their identity, or the memo would miss on every frame.
    (a.call.subagentDroppedTools?.join('\u0000') ?? '') ===
      (b.call.subagentDroppedTools?.join('\u0000') ?? '') &&
    // The verdict lands after the result; without this the badge never paints.
    JSON.stringify(a.call.verification) === JSON.stringify(b.call.verification) &&
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
  const t = useTranslations('chat');
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
  // The dispatch's own label wins; only pre-title sessions fall back to the
  // message's first line.
  const title = subagentTaskTitle(call.args, call.subagentTitle);
  const agentType = subagentTypeOf(call.args);
  // What the dispatch actually asked for — the same facts the executor used,
  // read straight off the call's args so the card never guesses.
  const badges: string[] = [];
  if (typeof call.args.background === 'boolean' && call.args.background) {
    badges.push(t('subagentCard.background'));
  }
  if (typeof call.args.model === 'string' && call.args.model !== '') {
    badges.push(call.args.model);
  }
  if (typeof call.args.max_iterations === 'number') {
    badges.push(t('subagentCard.maxIterations', { count: call.args.max_iterations }));
  }
  if (Array.isArray(call.args.tools)) {
    badges.push(t('subagentCard.tools', { count: call.args.tools.length }));
  }
  // The acceptance verdict rides the row vocabulary: a passed verdict is a
  // quiet badge; a failed or unverifiable one takes the amber warning slot —
  // the same marker dropped tools use — with its reasons on hover.
  const v = verificationBadge(t, call.verification);
  if (v !== undefined && v.warningDetail === undefined) badges.push(v.badge);
  const droppedWarning =
    call.subagentDroppedTools !== undefined && call.subagentDroppedTools.length > 0
      ? {
          warning: t('subagentCard.unavailable', {
            count: call.subagentDroppedTools.length,
          }),
          warningDetail: t('subagentCard.unavailableDetail', {
            tools: call.subagentDroppedTools.join('、'),
          }),
        }
      : undefined;
  // One slot, two possible sources: merged, the marker keeps both texts —
  // dropped-tools count and the verdict badge — joined with " · ", and the
  // hover detail merges both explanations the same way.
  const warningProps =
    droppedWarning !== undefined && v !== undefined
      ? {
          warning: `${droppedWarning.warning} · ${v.badge}`,
          warningDetail:
            v.warningDetail !== undefined
              ? `${droppedWarning.warningDetail} · ${v.warningDetail}`
              : droppedWarning.warningDetail,
        }
      : (droppedWarning ??
        (v !== undefined && v.warningDetail !== undefined
          ? { warning: v.badge, warningDetail: v.warningDetail }
          : undefined));

  return (
    <TraceRow
      icon={Bot}
      // The delegation's identity is which agent type ran, not the tool name:
      // "task" says nothing the glyph does not already say.
      label={agentType ?? 'general-purpose'}
      detail={title === '' ? undefined : title}
      badges={badges}
      // Declared-but-unavailable tools and acceptance failures share the one
      // warning slot: folded into a tinted marker whose detail names them on
      // hover, so the row stays one line.
      {...(warningProps ?? {})}
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
      onActivate={() =>
        onOpenSubagent?.(call.childSessionId ?? '', {
          ...(title !== '' ? { title } : {}),
          ...(agentType !== undefined ? { agentType } : {}),
        })
      }
      ariaLabel={t('common.subagent', { title }).trim()}
    />
  );
}, subagentCardComparator);
