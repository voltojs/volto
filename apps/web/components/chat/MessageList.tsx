'use client';

import { useEffect, useRef } from 'react';
import type { ChatEntry } from '@/lib/projection';
import { MessageBubble } from './MessageBubble';
import { ErrorNotice } from './ErrorNotice';
import { Notice } from './Notice';
import { WaveLoading } from './WaveLoading';
import { ActivitySteps } from './ActivitySteps';
import { AnswerRow } from './AnswerRow';
import { MessageFooter } from './MessageFooter';
import { groupFeedEntries } from '@/lib/feed-groups';
import { useStreamDensity } from '@/lib/stream-density';
import type { StreamDensity } from '@/lib/stream-density';

function renderEntry(entry: ChatEntry, sessionId?: string | null) {
  switch (entry.kind) {
    case 'message':
      // Assistant messages never reach here — the feed splits them into answer
      // rows and execution groups; only human turns stay whole bubbles.
      return <MessageBubble key={entry.message.id} message={entry.message} sessionId={sessionId} />;
    case 'error':
      return <ErrorNotice key={entry.key} text={entry.text} time={entry.time} />;
    case 'notice':
      return <Notice key={entry.key} text={entry.text} time={entry.time} />;
  }
}

export function MessageList({
  entries,
  onOpenSubagent,
  sessionId,
  isGenerating = false,
  density,
}: {
  entries: ChatEntry[];
  onOpenSubagent?: (childSessionId: string) => void;
  /** How much execution detail each bubble shows; omitted → stored preference. */
  density?: StreamDensity;
  /** Session for resolving image attachment refs; omitted → images stay as placeholders. */
  sessionId?: string | null;
  /** Round in flight for this feed — shows the bottom wave indicator. */
  isGenerating?: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  // Grouped rows need the density value itself; bubbles can fall back to the
  // stored preference on their own, but an execution group cannot.
  const [storedDensity] = useStreamDensity();
  const effectiveDensity = density ?? storedDensity;
  const rows = groupFeedEntries(entries);

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
        {rows.map((row) => {
          if (row.kind === 'answer') {
            return (
              <AnswerRow
                key={row.key}
                blocks={row.blocks}
                sessionId={sessionId}
                footer={row.footer}
              />
            );
          }
          if (row.kind === 'activity') {
            return (
              <div key={row.key} className="py-0.5">
                <ActivitySteps
                  blocks={row.blocks}
                  density={effectiveDensity}
                  onOpenSubagent={onOpenSubagent}
                />
                {row.footer !== null && <MessageFooter message={row.footer} />}
              </div>
            );
          }
          return renderEntry(row.entry, sessionId);
        })}
        {/* Unified loading: pinned under the feed so the existing scroll-to-
            bottom keeps it in view for the whole round. */}
        {isGenerating && <WaveLoading />}
      </div>
      <div ref={bottomRef} />
    </div>
  );
}
