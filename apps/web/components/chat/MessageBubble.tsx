'use client';

import { useState } from 'react';
import { Check, ChevronRight, CircleAlert, Copy, LoaderCircle } from 'lucide-react';
import { groupConversationBlocks } from '@volto/sdk/sse';
import type {
  ConversationBlock,
  ConversationMessage,
  ConversationSegment,
} from '@volto/sdk/sse';
import { useStreamDensity, type StreamDensity } from '@/lib/stream-density';
import { toolCallSummary } from '@/lib/tool-summary';
import { Markdown } from './Markdown';
import { SubagentCard } from './SubagentCard';
import { ToolCallCard } from './ToolCallCard';
import { TurnUsageChip } from './TurnUsageChip';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { SERVER_URL } from '@/lib/agent-config';
import { cn } from '@/lib/utils';

interface MessageBubbleProps {
  message: ConversationMessage;
  onOpenSubagent?: (childSessionId: string) => void;
  /**
   * Session whose attachment store holds any images this bubble references.
   * Without it the image src is skipped — a request with no sessionId is a
   * guaranteed 400 on the gateway.
   */
  sessionId?: string | null;
  /**
   * How much execution detail to show. Omitted → the user's stored preference
   * (see lib/stream-density), so callers that do not care stay unchanged.
   */
  density?: StreamDensity;
}

type ImageBlock = Extract<ConversationBlock, { type: 'image' }>;

/**
 * One history image: ref-only in state, resolved against the attachment route.
 *
 * Browser auth is the gateway's HttpOnly cookie on the same-origin `/gateway`
 * rewrite — a plain same-origin `<img>` carries it automatically, so no
 * crossOrigin / credentials plumbing exists (and `<img>` offers none).
 * A cleaned-up attachment degrades to an explanation rather than a broken
 * image icon: the icon cannot say why the picture is missing.
 */
function AttachmentImage({
  block,
  sessionId,
}: {
  block: ImageBlock;
  sessionId?: string | null;
  /**
   * How much execution detail to show. Omitted → the user's stored preference
   * (see lib/stream-density), so callers that do not care stay unchanged.
   */
  density?: StreamDensity;
}) {
  const [failed, setFailed] = useState(false);

  if (!sessionId || failed) {
    return (
      <div className="text-muted-foreground rounded-md border border-dashed px-2 py-1 text-xs">
        {failed ? '图片已不可用' : '[image]'}（{block.mediaType ?? 'image'} ·{' '}
        {block.attachmentId}）
      </div>
    );
  }

  const src = `${SERVER_URL}/attachments/${encodeURIComponent(block.attachmentId)}?sessionId=${encodeURIComponent(sessionId)}`;
  return (
    <img
      src={src}
      alt="attachment"
      className="max-h-64 max-w-full rounded-md object-contain"
      onError={() => setFailed(true)}
    />
  );
}

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
});

export function MessageBubble({
  message,
  onOpenSubagent,
  sessionId,
  density: densityProp,
}: MessageBubbleProps) {
  const [storedDensity] = useStreamDensity();
  const density = densityProp ?? storedDensity;
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // A user turn is a right-aligned bubble; the agent keeps the full-width
  // left column so its markdown, tool cards and reasoning panels still have
  // room to breathe.
  if (isUser) {
    // `content` is the concatenated text (clipboard surface); image refs live
    // only in `blocks`, so they need their own render path here.
    const images = message.blocks.filter(
      (b): b is ImageBlock => b.type === 'image',
    );
    return (
      <div className="animate-in-stagger flex justify-end py-2">
        <div className="bg-primary/10 text-foreground max-w-[85%] space-y-2 rounded-2xl rounded-br-md px-3.5 py-2 text-sm">
          {message.content !== '' && (
            <div className="whitespace-pre-wrap">{message.content}</div>
          )}
          {images.map((block, i) => (
            <AttachmentImage
              key={`${block.attachmentId}:${i}`}
              block={block}
              sessionId={sessionId}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="group animate-in-stagger py-1">
      {message.blocks.length === 0 ? (
        // Streaming but nothing rendered yet (first token in flight, or a
        // tool-using model that has not produced text): the bubble stays
        // empty on purpose — the bottom wave indicator carries loading.
        // Closed empty bubbles never reach here; the feed drops them up front.
        null
      ) : (
        <div className="space-y-2">
          {groupConversationBlocks(message.blocks).map((segment, segmentIndex) =>
            segment.kind === 'answer' ? (
              <div key={`answer-${segmentIndex}`} className="space-y-2">
                {segment.blocks.map((block, index) =>
                  block.type === 'image' ? (
                    <AttachmentImage
                      key={index}
                      block={block}
                      sessionId={sessionId}
                    />
                  ) : (
                    <Markdown key={index} content={block.text} />
                  ),
                )}
              </div>
            ) : (
              <ActivityRail
                key={`activity-${segmentIndex}`}
                segment={segment}
                density={density}
                onOpenSubagent={onOpenSubagent}
              />
            ),
          )}
        </div>
      )}

      {/* 页脚在两种情况下都要出现：有正文（可复制），或这一轮有用量可展示。
          纯工具调用结尾的轮次以前整块消失，用量 chip 正好补上这个盲区。 */}
      {!message.isStreaming &&
        (message.content !== '' || message.turnUsage !== undefined) && (
          <div className="mt-1 flex items-center gap-2">
            <span className="text-muted-foreground/70 font-mono text-[10px]">
              {timeFormatter.format(message.timestamp)}
            </span>
            {message.content !== '' && (
              <button
                type="button"
                onClick={() => void copy()}
                aria-label="复制"
                className={cn(
                  'text-muted-foreground hover:bg-muted hover:text-foreground flex items-center rounded px-1 py-0.5',
                )}
              >
                {copied ? (
                  <Check className="text-success h-3 w-3" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </button>
            )}
            {message.turnUsage !== undefined && (
              <TurnUsageChip usage={message.turnUsage} />
            )}
          </div>
        )}
    </div>
  );
}


/**
 * The execution layer of one turn.
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
function ActivityRail({
  segment,
  density,
  onOpenSubagent,
}: {
  segment: Extract<ConversationSegment, { kind: 'activity' }>;
  density: StreamDensity;
  onOpenSubagent?: (childSessionId: string) => void;
}) {
  const rows = segment.blocks.map((block, index) =>
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

  const calls = segment.blocks.filter((block) => block.type === 'tool_call');
  const reasoningCount = segment.blocks.length - calls.length;
  const running = [...calls].reverse().find((block) => block.call.result === undefined);
  const failed = calls.some(
    (block) => block.call.isError === true || block.call.approval?.decision === 'deny',
  );
  const label =
    running !== undefined
      ? `执行中 · ${running.call.name} · ${toolCallSummary(running.call.name, running.call.args)}`
      : calls.length > 0
        ? `已执行 ${calls.length} 步`
        : `思考 ${reasoningCount} 段`;

  return (
    <Collapsible
      data-testid="activity-group"
      defaultOpen={failed}
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
