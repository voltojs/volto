'use client';

import { useState } from 'react';
import { Brain, ListChecks, CircleAlert, LoaderCircle } from 'lucide-react';
import type { ConversationBlock } from '@volto/sdk/sse';
import type { StreamDensity } from '@/lib/stream-density';
import { toolCallSummary } from '@/lib/tool-summary';
import { SubagentCard } from './SubagentCard';
import { ToolCallCard } from './ToolCallCard';
import { TraceRow } from './TraceRow';

/** The block kinds the execution layer owns: calls, thinking, and the preamble text before a call. */
type ActivityBlock = Extract<ConversationBlock, { type: 'reasoning' | 'tool_call' | 'text' }>;

/**
 * The execution layer of one turn — or of several steps, which the feed merges
 * between two stretches of answer text.
 *
 * Detailed density lays every step out flat. Concise folds the whole
 * segment behind a single trace row whose label tracks the step currently
 * running, so a long turn still says what is happening without filling the
 * feed. Either way the answer stays outside.
 */
export function ActivitySteps({
  blocks,
  density,
  onOpenSubagent,
}: {
  blocks: ActivityBlock[];
  density: StreamDensity;
  onOpenSubagent?: (childSessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rows = blocks.map((block, index) =>
    block.type === 'reasoning' ? (
      <ReasoningRow key={`r-${index}`} text={block.text} />
    ) : block.type === 'text' ? (
      // Preamble the model wrote right before calling a tool ("Let me look…").
      // It belongs to the execution layer, not to the answer.
      <div
        key={`t-${index}`}
        className="text-muted-foreground/80 py-[2px] text-[13px] leading-[18px] whitespace-pre-wrap break-words"
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
  // an indent/rail around one row only shrinks it.
  if (blocks.length === 1 || density === 'detailed') {
    return <div data-testid="activity-rail">{rows}</div>;
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

  return (
    <TraceRow
      testId="activity-group"
      icon={ListChecks}
      label={label}
      failed={failed}
      status={
        running !== undefined ? (
          <LoaderCircle className="text-muted-foreground/60 h-3 w-3 animate-spin" />
        ) : failed ? (
          <CircleAlert className="text-destructive/70 h-3 w-3" />
        ) : undefined
      }
      open={open}
      onOpenChange={setOpen}
    >
      {/* Indent the steps under the group header: they are its contents, and
          the header's own icon already marks the column. */}
      <div className="space-y-0.5">{rows}</div>
    </TraceRow>
  );
}

/**
 * One reasoning block: the first line is the preview, the full text opens on
 * demand. Reasoning belongs to the execution layer — it explains the next call,
 * it is not part of the answer.
 */
function ReasoningRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = (text.split('\n')[0] ?? '').trim();
  return (
    <TraceRow
      icon={Brain}
      label="思考"
      detail={preview === '' ? undefined : preview}
      open={open}
      onOpenChange={setOpen}
      scrollable
    >
      <div className="text-muted-foreground/80 text-[13px] leading-relaxed whitespace-pre-wrap">
        {text}
      </div>
    </TraceRow>
  );
}
