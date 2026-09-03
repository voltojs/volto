'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { Message, MessageBlock } from '@/stores/chat-store';
import { StreamRenderer } from './StreamRenderer';
import { Markdown } from './Markdown';
import { ToolCallCard } from './ToolCallCard';
import { cn } from '@/lib/utils';

interface MessageBubbleProps {
  message: Message;
}

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
});

/** A message with no blocks yet (nothing streamed in) falls back to its plain `content`, if any. */
function resolveBlocks(message: Message): MessageBlock[] {
  if (message.blocks) return message.blocks;
  return message.content ? [{ type: 'text', text: message.content }] : [];
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);
  const blocks = resolveBlocks(message);

  const copy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group animate-in-stagger py-2.5">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span
          className={cn(
            'font-mono text-[10px] font-semibold tracking-[0.14em] uppercase',
            isUser ? 'text-muted-foreground' : 'text-primary',
          )}
        >
          {isUser ? 'user' : 'agent'}
        </span>
        <span className="text-muted-foreground/70 font-mono text-[10px]">
          {timeFormatter.format(message.timestamp)}
        </span>
        {!isUser && !message.isStreaming && message.content && (
          <button
            type="button"
            onClick={() => void copy()}
            className="text-muted-foreground hover:bg-muted hover:text-foreground ml-auto flex items-center gap-1 rounded px-1 py-0.5 font-mono text-[10px] opacity-0 transition-opacity group-hover:opacity-100"
          >
            {copied ? (
              <>
                <Check className="text-success h-3 w-3" /> 已复制
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" /> 复制
              </>
            )}
          </button>
        )}
      </div>

      <div
        className={cn(
          'border-l-2 pl-3',
          isUser ? 'border-border' : 'border-primary/40',
        )}
      >
        {isUser ? (
          <div className="text-foreground text-sm whitespace-pre-wrap">
            {message.content}
          </div>
        ) : blocks.length === 0 ? (
          // Nothing streamed in yet — still show the caret so the bubble
          // isn't empty while the first token is in flight.
          <StreamRenderer content="" />
        ) : (
          <div className="space-y-2">
            {blocks.map((block, index) =>
              block.type === 'tool_call' ? (
                <ToolCallCard key={block.call.id} call={block.call} />
              ) : index === blocks.length - 1 && message.isStreaming ? (
                <StreamRenderer key={index} content={block.text} />
              ) : (
                <Markdown key={index} content={block.text} />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
