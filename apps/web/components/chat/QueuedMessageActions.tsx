'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Textarea } from '@/components/ui/textarea';
import { updateQueue } from '@/hooks/use-chat-agent';
import { useChatStore } from '@/stores/chat-store';
import { cn } from '@/lib/utils';

interface QueuedMessageActionsProps {
  /** The steering id stamped at enqueue time — the queue item's address. */
  id: string;
  /** Current bubble text, prefilled into the inline editor. */
  content: string;
}

/**
 * Edit / retract controls for a QUEUED (not yet delivered) message bubble.
 *
 * Mounted by MessageList only while `message.queued === true`: delivery wins,
 * so once `steering_delivered` flips the flag the actions unmount with it and
 * editing is impossible by design. Neither action mutates the bubble locally
 * — the POST only asks the gateway, and the feed converges when the
 * `steering_edited` / `steering_removed` receipt folds in (no optimistic
 * echo, v1).
 *
 * Hover reveal follows the PermissionPicker pattern (`group` on the row,
 * opacity transition, `focus-within` so keyboard users reach the buttons).
 */
export function QueuedMessageActions({ id, content }: QueuedMessageActionsProps) {
  const t = useTranslations('chat');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Inline validation / transport failure under the editor; cleared on input.
  const [error, setError] = useState<string | null>(null);

  const empty = draft.trim() === '';

  const surfaceNotice = (text: string) => {
    useChatStore.getState().pushNotice({
      key: `queued-gone:${id}:${Date.now()}`,
      text,
      time: Date.now(),
    });
  };

  const surfaceFailure = (message: string) => {
    useChatStore.getState().pushEvent({
      time: Date.now(),
      type: 'error',
      data: { message },
    });
  };

  const save = async () => {
    if (empty) return;
    const outcome = await updateQueue(id, { kind: 'edit', content: draft });
    if (outcome.status === 'ok') {
      // Close the editor and wait for steering_edited to rewrite the bubble;
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
    const outcome = await updateQueue(id, { kind: 'remove' });
    if (outcome.status === 'ok') {
      // No local removal — steering_removed drops the bubble when it lands.
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
    setDraft(content);
    setError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setError(null);
  };

  return (
    <div
      className={cn(
        'mt-0.5 flex justify-end transition-opacity',
        editing
          ? 'opacity-100'
          : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
      )}
    >
      {editing ? (
        <div className="flex w-full flex-col items-end gap-1">
          <Textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            rows={3}
            aria-label={t('queuedEdit')}
            className="w-full max-w-[85%] text-sm"
          />
          {error !== null && (
            <p className="text-destructive text-xs">{error}</p>
          )}
          {error === null && empty && (
            <p className="text-muted-foreground text-xs">
              {t('queuedEmptyError')}
            </p>
          )}
          <div className="flex gap-1">
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
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
