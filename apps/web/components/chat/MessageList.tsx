'use client';

import { useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { ChatEntry } from '@/lib/projection';
import { MessageBubble } from './MessageBubble';
import { ErrorNotice } from './ErrorNotice';
import { Notice } from './Notice';
import { WaveLoading } from './WaveLoading';
import { ActivitySteps } from './ActivitySteps';
import type { SubagentOpenMeta } from './SubagentCard';
import { AnswerRow } from './AnswerRow';
import { MessageFooter } from './MessageFooter';
import { groupFeedEntries } from '@/lib/feed-groups';
import { collectTurnFileChanges } from '@/lib/turn-file-changes';
import { FileChangesCard } from './FileChangesCard';
import { useStreamDensity } from '@/lib/stream-density';
import { useFileRefsStore } from '@/stores/file-refs-store';
import type { StreamDensity } from '@/lib/stream-density';
import { cn } from '@/lib/utils';

function renderEntry(entry: ChatEntry, sessionId?: string | null) {
  switch (entry.kind) {
    case 'message':
      // Assistant messages never reach here — the feed splits them into answer
      // rows and execution groups; only human turns stay whole bubbles.
      // Queued (not yet delivered) messages never reach here either — they
      // live in the QueuedDock above the composer (spec D16), filtered out
      // before grouping below.
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
  fileProjectId,
  isGenerating = false,
  density,
  scrollable = true,
}: {
  entries: ChatEntry[];
  onOpenSubagent?: (childSessionId: string, meta?: SubagentOpenMeta) => void;
  /** How much execution detail each bubble shows; omitted → stored preference. */
  density?: StreamDensity;
  /** Session for resolving image attachment refs; omitted → images stay as placeholders. */
  sessionId?: string | null;
  /**
   * Project the content belongs to (undefined → current session at click
   * time). Sub-agent feeds pass their parent's project explicitly.
   */
  fileProjectId?: string | null;
  /** Round in flight for this feed — shows the bottom wave indicator. */
  isGenerating?: boolean;
  /**
   * Whether the feed owns its scrolling. A host that keeps the scrollbar
   * outside the widened conversation column (ChatPanel) passes `false` and
   * scrolls the whole thread itself, so the bar sits on the pane edge rather
   * than on the max-width column's edge. `scrollIntoView` still reaches the
   * host's scroller because it walks the nearest scrollable ancestor.
   */
  scrollable?: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  // Grouped rows need the density value itself; bubbles can fall back to the
  // stored preference on their own, but an execution group cannot.
  const [storedDensity] = useStreamDensity();
  const effectiveDensity = density ?? storedDensity;
  // The conversation renders only DELIVERED entries (spec D16): a still
  // queued message lives in the QueuedDock above the composer and rejoins
  // this flow — at its send position, unchanged — once steering_delivered
  // flips `queued` to false.
  const delivered = entries.filter(
    (entry) => entry.kind !== 'message' || entry.message.queued !== true,
  );
  const rows = groupFeedEntries(delivered);
  // Turn-end change summary: the write tools' captured diffs, folded per turn.
  // Rows carry their turn so the card lands after the turn's last row — before
  // the next user bubble — rather than at the bottom of the whole feed.
  const changesByTurn = useMemo(() => collectTurnFileChanges(delivered), [delivered]);
  // The summary belongs to the END of a turn: while the round is still
  // generating (a turn_start without its turn_end), the last turn's card stays
  // hidden and appears the moment the turn closes. Earlier turns keep theirs —
  // only the turn in flight is incomplete.
  const lastRow = rows[rows.length - 1];
  const streamingTurn = isGenerating ? lastRow?.turn : undefined;
  const lastRowOfTurn = useMemo(() => {
    const last = new Map<string, number>();
    rows.forEach((row, index) => {
      if (row.turn !== '') last.set(row.turn, index);
    });
    return last;
  }, [rows]);
  // Annotations arrive per session (row-keyed); slice them per answer row so
  // chips render only where the host confirmed a file identity.
  const fileRefs = useFileRefsStore((s) =>
    sessionId != null ? s.bySession[sessionId] : undefined,
  );
  const refsByKey = useMemo(
    () => new Map((fileRefs ?? []).map((r) => [r.rowKey, r.blockRefs])),
    [fileRefs],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  return (
    <div className={cn(scrollable ? 'flex-1 overflow-y-auto' : 'shrink-0')}>
      {/* No dividers between entries: user turns are right-aligned bubbles and
          agent turns flow on the left, so the thread reads as one continuous
          conversation rather than a list of separated rows. */}
      {/* The callback is captured in an inline closure instead of passing
          `renderEntry` straight to `map` (map would feed the index as the
          second argument); the reference handed down stays whatever the
          caller passed, so downstream memo comparators see a stable prop. */}
      <div className="py-2">
        {rows.flatMap((row, index) => {
          const changes = changesByTurn.get(row.turn);
          const card =
            changes !== undefined &&
            changes.length > 0 &&
            row.turn !== streamingTurn &&
            lastRowOfTurn.get(row.turn) === index ? (
              <FileChangesCard
                key={`changes-${row.turn}-${index}`}
                turn={row.turn}
                changes={changes}
                projectId={fileProjectId}
              />
            ) : null;
          const renderWithCard = (node: ReactNode): ReactNode[] =>
            card === null ? [node] : [node, card];
          if (row.kind === 'answer') {
            return renderWithCard(
              <AnswerRow
                key={row.key}
                blocks={row.blocks}
                sessionId={sessionId}
                footer={row.footer}
                fileProjectId={fileProjectId}
                blockRefs={refsByKey.get(row.key)}
              />,
            );
          }
          if (row.kind === 'activity') {
            return renderWithCard(
              <div key={row.key} className="py-0.5">
                <ActivitySteps
                  blocks={row.blocks}
                  density={effectiveDensity}
                  onOpenSubagent={onOpenSubagent}
                  fileProjectId={fileProjectId}
                />
                {row.footer !== null && <MessageFooter message={row.footer} />}
              </div>,
            );
          }
          return renderWithCard(renderEntry(row.entry, sessionId));
        })}
        {/* Unified loading: pinned under the feed so the existing scroll-to-
            bottom keeps it in view for the whole round. */}
        {isGenerating && <WaveLoading />}
      </div>
      <div ref={bottomRef} />
    </div>
  );
}
