'use client';

import { useEffect, useRef } from 'react';
import type { ChatEntry } from '@/lib/projection';
import { MessageBubble } from './MessageBubble';
import { ErrorNotice } from './ErrorNotice';

export function MessageList({ entries }: { entries: ChatEntry[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="divide-border/60 mx-auto max-w-3xl divide-y px-6 py-2">
        {entries.map((entry) =>
          entry.kind === 'message' ? (
            <MessageBubble key={entry.message.id} message={entry.message} />
          ) : (
            <ErrorNotice key={entry.key} text={entry.text} time={entry.time} />
          ),
        )}
      </div>
      <div ref={bottomRef} />
    </div>
  );
}
