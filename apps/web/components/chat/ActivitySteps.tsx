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

/** The block kinds the execution layer owns: calls, thinking, and the preamble text before a call. */
type ActivityBlock = Extract<ConversationBlock, { type: 'reasoning' | 'tool_call' | 'text' }>;

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
    ) : block.type === 'text' ? (
      // Preamble the model wrote right before calling a tool ("Let me look…").
      // It belongs to the execution layer, not to the answer.
      <div
        key={`t-${index}`}
        className="text-muted-foreground/80 py-[3px] pl-6 text-[13px] leading-5 whitespace-pre-wrap break-words"
      >
        {block.text}
      </div>
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

  // A single step needs no wrapper at all: the control would carry the same
  // text the one row below it already shows, its fold has nothing to hide, and
  // an indent/rail around one row only shrinks it. Align to the left edge.
  if (blocks.length === 1) {
    return <>{rows}</>;
  }

  if (density === 'detailed') {
    return (
      <div data-testid="activity-rail" className="space-y-0.5">
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
      className="group/activity"
    >
      <CollapsibleTrigger className="text-muted-foreground group flex w-full cursor-pointer items-center gap-1.5 rounded px-1.5 py-[3px] text-left text-[13px] leading-5 transition-colors select-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none">
        <ChevronRight className="text-muted-foreground/40 h-3 w-3 shrink-0 transition-transform duration-150 group-data-[panel-open]:rotate-90" />
        {running !== undefined && (
          <LoaderCircle className="text-muted-foreground/60 h-3 w-3 shrink-0 animate-spin" />
        )}
        <span className="truncate">{label}</span>
        {failed && <CircleAlert className="text-destructive/70 ml-auto h-3 w-3 shrink-0" />}
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
        <div className="space-y-0.5 pl-3">{rows}</div>
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
    <Collapsible className="group/reason">
      <CollapsibleTrigger className="text-muted-foreground group flex w-full cursor-pointer items-center gap-1.5 rounded px-1.5 py-[3px] text-left text-[13px] leading-5 transition-colors select-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none">
        <ChevronRight className="text-muted-foreground/40 h-3 w-3 shrink-0 transition-transform duration-150 group-data-[panel-open]:rotate-90" />
        <span className="shrink-0">思考</span>
        {preview !== '' && (
          <span className="text-muted-foreground/70 truncate">{preview}</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
        <div className="text-muted-foreground/80 mt-1 mb-1.5 pl-6 text-[13px] leading-relaxed whitespace-pre-wrap">
          {text}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
