'use client';

import { ChevronRight, CircleAlert, LoaderCircle } from 'lucide-react';
import type { ConversationBlock } from '@volto/sdk/sse';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import type { StreamDensity } from '@/lib/stream-density';
import { toolCallSummary } from '@/lib/tool-summary';
import { SubagentCard } from './SubagentCard';
import { ToolCallCard } from './ToolCallCard';

/** The two block kinds the execution layer owns. */
type ActivityBlock = Extract<ConversationBlock, { type: 'reasoning' | 'tool_call' }>;

/**
 * The execution layer of one turn — or of several consecutive tool-only steps,
 * which the feed merges so one turn yields one group in concise density.
 *
 * Detailed density lays every step out flat: one row per tool call (name ·
 * summary · duration) and one per reasoning block (with a first-line
 * preview), each expandable for args/output. Concise folds the whole segment
 * behind a single control whose label tracks the step currently running, so
 * a long turn still shows what is happening without filling the feed.
 *
 * Either way the answer stays outside; blocks keep their order, so a tool
 * call stays where it actually happened.
 */
export function ActivitySteps({
  blocks,
  density,
  onOpenSubagent,
}: {
  /** Ordered reasoning / tool-call blocks, possibly spanning several steps. */
  blocks: ActivityBlock[];
  density: StreamDensity;
  onOpenSubagent?: (childSessionId: string) => void;
}) {
  const rows = blocks.map((block, index) =>
    block.type === 'reasoning' ? (
      <ReasoningRow key={`r-${index}`} text={block.text} />
    ) : block.call.childSessionId !== undefined ? (
      <SubagentCard
        key={block.call.id}
        call={block.call}
        onOpenSubagent={onOpenSubagent}
      />
    ) : (
      <ToolCallCard
        key={block.call.id}
        call={block.call}
        label={toolCallSummary(block.call.name, block.call.args)}
      />
    ),
  );

  if (density === 'detailed') {
    return (
      <div data-testid="activity-rail" className="ml-1 space-y-1 border-l border-border/60 pl-3">
        {rows}
      </div>
    );
  }

  const calls = blocks.filter((block) => block.type === 'tool_call');
  const reasoningCount = blocks.length - calls.length;
  const running = [...calls].reverse().find((block) => block.call.result === undefined);
  const failedCalls = calls.filter(
    (block) => block.call.isError === true || block.call.approval?.decision === 'deny',
  );
  const failed = failedCalls.length > 0;
  const failureSummary = failedCalls
    .map((block) =>
      block.call.approval?.decision === 'deny'
        ? `${block.call.name} 被拒绝`
        : `${block.call.name} · ${firstLineClipped(block.call.result ?? '执行失败')}`,
    )
    .join(' ｜ ');
  const label =
    running !== undefined
      ? `执行中 · ${running.call.name} · ${toolCallSummary(running.call.name, running.call.args)}`
      : calls.length > 0
        ? `已执行 ${calls.length} 步${failed ? ` · ${failedCalls.length} 步失败` : ''}`
        : `思考 ${reasoningCount} 段`;

  // Folding is the point of this density, so the group itself never springs
  // open — not even on failure. The failure is surfaced on the header and as
  // a one-line summary beneath it instead, which stays visible while the
  // steps stay folded.
  return (
    <Collapsible
      data-testid="activity-group"
      className="ml-1 rounded-md border border-border/60"
    >
      <CollapsibleTrigger className="text-muted-foreground group flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-left text-xs select-none">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-data-[panel-open]:rotate-90" />
        {running !== undefined && (
          <LoaderCircle className="text-primary h-3 w-3 shrink-0 animate-spin" />
        )}
        <span className="truncate">{label}</span>
        {failed && <CircleAlert className="text-destructive ml-auto h-3 w-3 shrink-0" />}
      </CollapsibleTrigger>
      {failed && (
        <div
          data-testid="activity-group-failure"
          className="text-destructive/90 border-t px-2.5 py-1 text-[11px] break-words"
        >
          {failureSummary}
        </div>
      )}
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
        <div className="space-y-1 border-t px-2 py-1.5">{rows}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * One reasoning block as a row rather than a wall of prose: the first line is
 * the preview, the full text opens on demand. Reasoning belongs to the
 * execution layer — it explains the next call, it is not part of the answer.
 */
function ReasoningRow({ text }: { text: string }) {
  const preview = (text.split('\n')[0] ?? '').trim();
  return (
    <Collapsible className="border-border/60 bg-muted/40 rounded-md border px-3 py-1.5">
      <CollapsibleTrigger className="text-muted-foreground group flex w-full cursor-pointer items-center gap-1 text-left text-xs select-none">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-data-[panel-open]:rotate-90" />
        <span className="shrink-0">思考</span>
        {preview !== '' && (
          <>
            <span className="text-muted-foreground/70 shrink-0">·</span>
            <span className="truncate">{preview}</span>
          </>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
        <div className="text-muted-foreground mt-2 text-xs whitespace-pre-wrap">{text}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** First line of a tool's output, clipped to a readable length. */
function firstLineClipped(text: string): string {
  const line = (text.split('\n')[0] ?? '').trim();
  const points = Array.from(line);
  return points.length <= 120 ? line : `${points.slice(0, 119).join('')}…`;
}
