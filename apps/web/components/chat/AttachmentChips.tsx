'use client';

/**
 * Pending-attachment chips shown above the composer.
 *
 * Each chip is one optimistic upload from usePendingAttachments: images get
 * a local thumbnail, non-image files (text / PDF, spec D6) get a file icon
 * plus the filename — never a thumbnail. Every chip carries an optional
 * filename, a remove button, and — when the upload failed — a retry
 * affordance. Removing a chip never touches the editor's text; the two
 * states are independent.
 */

import { X, RotateCw, FileText } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { PendingAttachmentItem } from '@/hooks/use-attachments';

export interface AttachmentChipsProps {
  items: PendingAttachmentItem[];
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}

export function AttachmentChips({ items, onRemove, onRetry }: AttachmentChipsProps) {
  const t = useTranslations('chat');
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3.5 pt-2">
      {items.map((item) => (
        <div
          key={item.localId}
          data-testid="attachment-chip"
          data-status={item.status}
          className="bg-muted/60 relative flex items-center gap-2 rounded-md border py-1 pr-1 pl-1.5"
        >
          {item.previewUrl ? (
            <img
              src={item.previewUrl}
              alt={item.name ?? 'attachment'}
              className="h-8 w-8 rounded object-cover"
            />
          ) : (
            // Non-image item (spec D6): filename + file icon, no thumbnail.
            <FileText className="text-muted-foreground h-8 w-8 p-1.5" />
          )}
          {item.name && (
            <span className="max-w-32 truncate text-xs">{item.name}</span>
          )}
          {item.status === 'failed' && (
            <button
              type="button"
              data-testid="attachment-chip-retry"
              aria-label={t('common.retryUpload')}
              className="text-muted-foreground hover:text-foreground rounded p-0.5"
              onClick={() => onRetry(item.localId)}
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            data-testid="attachment-chip-remove"
            aria-label={t('common.removeAttachment')}
            className="text-muted-foreground hover:text-foreground rounded p-0.5"
            onClick={() => onRemove(item.localId)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
