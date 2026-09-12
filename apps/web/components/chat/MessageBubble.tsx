'use client';

import { useState } from 'react';
import { Check, ChevronRight, Copy } from 'lucide-react';
import type { ConversationMessage } from '@volto/sdk/sse';
import { StreamRenderer } from './StreamRenderer';
import { Markdown } from './Markdown';
import { ToolCallCard } from './ToolCallCard';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

interface MessageBubbleProps {
  message: ConversationMessage;
  onOpenSubagent?: (childSessionId: string) => void;
}

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
});

export function MessageBubble({ message, onOpenSubagent }: MessageBubbleProps) {
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
    return (
      <div className="animate-in-stagger flex justify-end py-2">
        <div className="bg-primary/10 text-foreground max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2 text-sm whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="group animate-in-stagger py-2">
      {message.blocks.length === 0 ? (
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
                <Collapsible
                  key={index}
                  defaultOpen
                  className="border-border/60 bg-muted/40 my-2 rounded-md border px-3 py-2"
                >
                  <CollapsibleTrigger className="text-muted-foreground group flex w-full cursor-pointer items-center gap-1 text-left text-xs select-none">
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-data-[panel-open]:rotate-90" />
                    思考过程
                  </CollapsibleTrigger>
                  <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0">
                    <div className="text-muted-foreground mt-2 text-xs whitespace-pre-wrap">
                      {block.text}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              );
            }
            if (block.type === 'tool_call') {
              return (
                <ToolCallCard
                  key={block.call.id}
                  call={block.call}
                  onOpenSubagent={onOpenSubagent}
                />
              );
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

      {!message.isStreaming && message.content && (
        <div className="mt-1 flex items-center gap-2">
          <span className="text-muted-foreground/70 font-mono text-[10px]">
            {timeFormatter.format(message.timestamp)}
          </span>
          <button
            type="button"
            onClick={() => void copy()}
            className={cn(
              'text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-1 rounded px-1 py-0.5 font-mono text-[10px]',
              'opacity-0 transition-opacity group-hover:opacity-100',
            )}
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
        </div>
      )}
    </div>
  );
}
