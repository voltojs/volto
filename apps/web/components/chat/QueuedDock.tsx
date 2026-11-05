'use client';

/**
 * Queue dock — the FIFO list of NOT-yet-delivered messages pinned directly
 * above the composer (spec D16, superseding Task 14's in-conversation
 * bubbles).
 *
 * Reads the SAME `projectConversation` entries MessageList renders and takes
 * the `queued === true` slice, so the two surfaces stay isomorphic: an entry
 * leaves the dock the moment `steering_delivered` flips its flag, and shows
 * up in the conversation flow at its send position instead.
 *
 * Item layout: [attachment chip — count + icon, hover popup lists the
 * attachments] [single-line content with ellipsis] [queued badge, then the
 * edit/retract buttons on the right]. Edit is a MULTILINE textarea whose
 * save stays disabled on a trim-empty draft (`queuedEmptyError`); unlike the
 * composer, Enter never submits here — it only inserts a newline, because
 * this is a form over an existing message, not a send box.
 *
 * Nothing mutates optimistically: a POST only asks the gateway, and the dock
 * converges when the `steering_edited` / `steering_removed` receipt folds
 * into the feed (no optimistic echo, v1). A 409 surfaces the
 * `queuedGoneNotice` — the entry is already gone server-side.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Paperclip } from 'lucide-react';
import type { ConversationBlock } from '@volto/sdk/sse';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { updateQueue } from '@/hooks/use-chat-agent';
import { useChatStore } from '@/stores/chat-store';
import type { ChatEntry, FeedMessage } from '@/lib/projection';

interface QueuedDockProps {
  /** The full projected feed; the dock keeps the still-queued messages. */
  entries: ChatEntry[];
}

/** A queued entry's attachment: every non-text block of its content. */
type Attachment = Exclude<ConversationBlock, { type: 'text' }>;

function attachmentsOf(message: FeedMessage): Attachment[] {
  return message.blocks.filter(
    (block): block is Attachment => block.type !== 'text',
  );
}

/** One popup line: the media type identifies the attachment (no filename
 *  exists in a content block, so the type is the whole honest label). */
function attachmentLabel(block: Attachment): string {
  if (block.type === 'image') return block.mediaType ?? block.type;
  return block.type;
}

function attachmentKey(block: Attachment, index: number): string {
  return block.type === 'image'
    ? `${block.attachmentId}:${index}`
    : `${block.type}:${index}`;
}

function QueuedItem({ message }: { message: FeedMessage }) {
  const t = useTranslations('chat');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Inline validation / transport failure under the editor; cleared on input.
  const [error, setError] = useState<string | null>(null);

  const attachments = attachmentsOf(message);
  const empty = draft.trim() === '';

  const surfaceNotice = (text: string) => {
    useChatStore.getState().pushNotice({
      key: `queued-gone:${message.id}:${Date.now()}`,
      text,
      time: Date.now(),
    });
  };

  const surfaceFailure = (text: string) => {
    useChatStore.getState().pushEvent({
      time: Date.now(),
      type: 'error',
      data: { message: text },
    });
  };

  const save = async () => {
    if (empty) return;
    const outcome = await updateQueue(message.id, { kind: 'edit', content: draft });
    if (outcome.status === 'ok') {
      // Close the editor and wait for steering_edited to rewrite the entry;
      // showing the draft here would be the optimistic echo v1 skips.
      setEditing(false);
      setError(null);
      return;
    }
    if (outcome.status === 'gone') {
      setEditing(false);
      surfaceNotice(t('queuedGoneNotice'));
      return;
    }
    setError(
      outcome.status === 'invalid' ? t('queuedEmptyError') : outcome.message,
    );
  };

  const retract = async () => {
    const outcome = await updateQueue(message.id, { kind: 'remove' });
    if (outcome.status === 'ok') {
      // No local removal — steering_removed drops the entry when it lands.
      return;
    }
    if (outcome.status === 'gone') {
      surfaceNotice(t('queuedGoneNotice'));
      return;
    }
    surfaceFailure(
      outcome.status === 'invalid' ? t('queuedEmptyError') : outcome.message,
    );
  };

  const startEdit = () => {
    setDraft(message.content);
    setError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setError(null);
  };

  return (
    <li
      data-testid="queued-item"
      className="bg-card/80 group rounded-lg border px-2.5 py-1.5 shadow-sm"
    >
      <div className="flex items-center gap-2">
        {attachments.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-testid="queued-attachment-chip"
                  aria-label={t('queuedAttachments', {
                    count: attachments.length,
                  })}
                  className="text-muted-foreground bg-muted/60 hover:text-foreground flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]"
                />
              }
            >
              <Paperclip className="h-3 w-3" />
              <span>{attachments.length}</span>
            </TooltipTrigger>
            <TooltipContent>
              <ul className="flex flex-col gap-0.5">
                {attachments.map((block, index) => (
                  <li key={attachmentKey(block, index)}>
                    {attachmentLabel(block)}
                  </li>
                ))}
              </ul>
            </TooltipContent>
          </Tooltip>
        )}
        <span
          data-testid="queued-content"
          className="min-w-0 flex-1 truncate text-sm"
        >
          {message.content}
        </span>
        {/* Badge stays visible while editing (the message must read as
            queued); the actions collapse to the editor's own Save/Cancel. */}
        <span className="text-muted-foreground border-border bg-muted/50 inline-flex shrink-0 items-center rounded-full border px-1.5 py-px font-mono text-[10px]">
          {t('queuedBadge')}
        </span>
        {!editing && (
          <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              onClick={startEdit}
              className="text-muted-foreground hover:bg-muted hover:text-foreground rounded px-1.5 py-0.5 text-xs"
            >
              {t('queuedEdit')}
            </button>
            <button
              type="button"
              onClick={() => void retract()}
              className="text-muted-foreground hover:bg-muted hover:text-foreground rounded px-1.5 py-0.5 text-xs"
            >
              {t('queuedRemove')}
            </button>
          </div>
        )}
      </div>
      {editing && (
        <div className="mt-1.5 flex flex-col gap-1">
          <Textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            rows={3}
            aria-label={t('queuedEdit')}
            className="w-full text-sm"
          />
          {error !== null && (
            <p className="text-destructive text-xs">{error}</p>
          )}
          {error === null && empty && (
            <p className="text-muted-foreground text-xs">
              {t('queuedEmptyError')}
            </p>
          )}
          <div className="flex justify-end gap-1">
            <button
              type="button"
              disabled={empty}
              onClick={() => void save()}
              className="text-muted-foreground hover:bg-muted hover:text-foreground rounded px-1.5 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('queuedSave')}
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              className="text-muted-foreground hover:bg-muted hover:text-foreground rounded px-1.5 py-0.5 text-xs"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * The dock itself: FIFO order is the feed's send order, and an empty queue
 * renders nothing at all — no chrome when there is nothing queued.
 */
export function QueuedDock({ entries }: QueuedDockProps) {
  const queued = entries.filter(
    (entry): entry is Extract<ChatEntry, { kind: 'message' }> =>
      entry.kind === 'message' && entry.message.queued === true,
  );
  if (queued.length === 0) return null;
  return (
    <ul data-testid="queued-dock" className="mb-2 flex flex-col gap-1.5">
      {queued.map(({ message }) => (
        <QueuedItem key={message.id} message={message} />
      ))}
    </ul>
  );
}
