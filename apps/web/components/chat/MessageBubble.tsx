'use client';

import type { Message } from '@/stores/chat-store';
import { StreamRenderer } from './StreamRenderer';
import { cn } from '@/lib/utils';

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div
      className={cn(
        'flex w-full',
        isUser ? 'justify-end' : 'justify-start'
      )}
    >
      <div
        className={cn(
          'max-w-[70%] rounded-lg px-4 py-2',
          isUser
            ? 'bg-blue-500 text-white'
            : 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100'
        )}
      >
        {message.isStreaming ? (
          <StreamRenderer content={message.content} />
        ) : (
          <div className="whitespace-pre-wrap">{message.content}</div>
        )}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mt-2 text-xs opacity-70">
            {message.toolCalls.length} tool call(s)
          </div>
        )}
      </div>
    </div>
  );
}
