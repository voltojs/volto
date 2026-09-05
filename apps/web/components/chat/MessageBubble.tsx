'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { ConversationMessage } from '@volto/sdk/sse';
import { StreamRenderer } from './StreamRenderer';
import { Markdown } from './Markdown';
import { ToolCallCard } from './ToolCallCard';
import { cn } from '@/lib/utils';

interface MessageBubbleProps {
  message: ConversationMessage;
}

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
});

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);

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
        ) : message.blocks.length === 0 ? (
          // Streaming but nothing rendered yet (e.g. the first token is in
          // flight, or a tool-using model has not produced text) — show the
          // caret so the bubble isn't empty while the turn is alive. Closed
          // empty bubbles never reach here; the feed drops them up front.
          message.isStreaming ? (
            <StreamRenderer content="" />
          ) : null
        ) : (
          <div className="space-y-2">
            {message.blocks.map((block, index) => {
              if (block.type === 'reasoning') {
                return (
                  <details
                    key={index}
                    className="border-border/60 bg-muted/40 my-2 rounded-md border px-3 py-2"
                  >
                    <summary className="text-muted-foreground cursor-pointer text-xs select-none">
                      思考过程
                    </summary>
                    <div className="text-muted-foreground mt-2 text-xs whitespace-pre-wrap">
                      {block.text}
                    </div>
                  </details>
                );
              }
              if (block.type === 'tool_call') {
                return <ToolCallCard key={block.call.id} call={block.call} />;
              }
              const isStreamingTail =
                message.isStreaming && index === message.blocks.length - 1;
              return isStreamingTail ? (
                <StreamRenderer key={index} content={block.text} />
              ) : (
                <Markdown key={index} content={block.text} />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
