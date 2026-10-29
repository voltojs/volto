'use client';

import { useEffect, useRef } from 'react';
import type { ChatEntry } from '@/lib/projection';
import { MessageBubble } from './MessageBubble';
import { ErrorNotice } from './ErrorNotice';
import { Notice } from './Notice';
import { WaveLoading } from './WaveLoading';
import { TodoTransitionLine } from './TodoTransitionLine';

function renderEntry(
  entry: ChatEntry,
  onOpenSubagent?: (childSessionId: string) => void,
  sessionId?: string | null,
) {
  switch (entry.kind) {
    case 'message':
      return (
        <MessageBubble
          key={entry.message.id}
          message={entry.message}
          onOpenSubagent={onOpenSubagent}
          sessionId={sessionId}
        />
      );
    case 'error':
      return <ErrorNotice key={entry.key} text={entry.text} time={entry.time} />;
    case 'notice':
      return <Notice key={entry.key} text={entry.text} time={entry.time} />;
    case 'todo':
      return <TodoTransitionLine key={entry.key} transition={entry.transition} />;
  }
}

export function MessageList({
  entries,
  onOpenSubagent,
  sessionId,
  isGenerating = false,
}: {
  entries: ChatEntry[];
  onOpenSubagent?: (childSessionId: string) => void;
  /** Session for resolving image attachment refs; omitted → images stay as placeholders. */
  sessionId?: string | null;
  /** Round in flight for this feed — shows the bottom wave indicator. */
  isGenerating?: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  return (
    <div className="flex-1 overflow-y-auto">
      {/* No dividers between entries: user turns are right-aligned bubbles and
          agent turns flow on the left, so the thread reads as one continuous
          conversation rather than a list of separated rows. */}
      {/* The callback is captured in an inline closure instead of passing
          `renderEntry` straight to `map` (map would feed the index as the
          second argument); the reference handed down stays whatever the
          caller passed, so downstream memo comparators see a stable prop. */}
      <div className="mx-auto max-w-3xl px-6 py-2">
        {entries.map((entry) => renderEntry(entry, onOpenSubagent, sessionId))}
        {/* Unified loading: pinned under the feed so the existing scroll-to-
            bottom keeps it in view for the whole round. */}
        {isGenerating && <WaveLoading />}
      </div>
      <div ref={bottomRef} />
    </div>
  );
}
