'use client';

import { useChatStore } from '@/stores/chat-store';
import { MessageBubble } from './MessageBubble';
import { useEffect, useRef } from 'react';

export function MessageList() {
  const messages = useChatStore((state) => state.messages);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.length === 0 ? (
        <div className="flex items-center justify-center h-full text-gray-400">
          Start a conversation...
        </div>
      ) : (
        messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))
      )}
      <div ref={bottomRef} />
    </div>
  );
}
