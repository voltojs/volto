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
    <div className="flex-1 overflow-y-auto">
      <div className="divide-border/60 mx-auto max-w-3xl divide-y px-6 py-2">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </div>
      <div ref={bottomRef} />
    </div>
  );
}
