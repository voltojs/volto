'use client';

import { useState } from 'react';
import { Check, ChevronRight, CircleAlert, Copy, LoaderCircle } from 'lucide-react';
import { groupConversationBlocks } from '@volto/sdk/sse';
import { ActivitySteps } from './ActivitySteps';
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
              <ActivitySteps
                key={`activity-${segmentIndex}`}
                blocks={segment.blocks}
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
