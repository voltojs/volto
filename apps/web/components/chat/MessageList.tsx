'use client';

import { useEffect, useRef } from 'react';
import type { ChatEntry } from '@/lib/projection';
import { MessageBubble } from './MessageBubble';
import { ErrorNotice } from './ErrorNotice';
import { Notice } from './Notice';

function renderEntry(entry: ChatEntry) {
  switch (entry.kind) {
    case 'message':
      return <MessageBubble key={entry.message.id} message={entry.message} />;
    case 'error':
      return <ErrorNotice key={entry.key} text={entry.text} time={entry.time} />;
    case 'notice':
      return <Notice key={entry.key} text={entry.text} time={entry.time} />;
  }
}

export function MessageList({ entries }: { entries: ChatEntry[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  return (
    <div className="flex-1 overflow-y-auto">
      {/* No dividers between entries: user turns are right-aligned bubbles and
          agent turns flow on the left, so the thread reads as one continuous
          conversation rather than a list of separated rows. */}
      <div className="mx-auto max-w-3xl px-6 py-2">{entries.map(renderEntry)}</div>
      <div ref={bottomRef} />
    </div>
  );
}
