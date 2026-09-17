'use client';

/**
 * Pending-image state for the composer: optimistic list of local picks,
 * each either still uploading, ready (server id in hand), or failed.
 *
 * A failed upload is never dropped from the list — silently discarding it
 * would leave the user believing the picture is still attached. `retry`
 * reuses the original `localId` so the chip does not duplicate.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { uploadAttachment } from '@/lib/attachments-api';

export type PendingAttachmentStatus = 'uploading' | 'ready' | 'failed';

export interface PendingAttachmentItem {
  localId: string;
  status: PendingAttachmentStatus;
  /** Server attachment id; present once status is 'ready'. */
  id?: string;
  /** Object URL for local thumbnail preview; revoked on remove/clear. */
  previewUrl: string;
  name?: string;
  mimeType?: string;
  /** Failure message from the last upload attempt, when status is 'failed'. */
  error?: string;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

let localIdSeq = 0;
function nextLocalId(): string {
  localIdSeq += 1;
  return `att-local-${localIdSeq}`;
}

export function usePendingAttachments(sessionId: string) {
  const [items, setItems] = useState<PendingAttachmentItem[]>([]);
  // The original File must survive for retry; keeping it out of React state
  // avoids re-render churn and keeps the public item shape serializable.
  const filesRef = useRef(new Map<string, File>());
  // Mirror of `items` for the unmount cleanup below — a ref is readable
  // from the effect closure without re-subscribing on every list change.
  const itemsRef = useRef<PendingAttachmentItem[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Drop object URLs when the hook unmounts so a remounted composer does
  // not leak the previous session's blob handles.
  useEffect(() => {
    const files = filesRef.current;
    return () => {
      for (const item of itemsRef.current) {
        URL.revokeObjectURL(item.previewUrl);
      }
      files.clear();
    };
  }, []);

  /**
   * Drop every pending item: revoke object URLs and forget the source Files.
   * Side effects run outside any setItems updater — React Strict Mode
   * double-invokes updaters, so they must stay pure.
   */
  const resetAll = useCallback((): void => {
    for (const item of itemsRef.current) {
      URL.revokeObjectURL(item.previewUrl);
    }
    filesRef.current.clear();
    setItems([]);
  }, []);

  // Pending attachments are session-scoped: a failed pick from session A
  // must not be retried (or shown) under session B. Reset on change rather
  // than relying on consumers to remount with key={sessionId}.
  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return;
    prevSessionIdRef.current = sessionId;
    resetAll();
  }, [sessionId, resetAll]);

  const uploadOne = useCallback(
    async (localId: string, file: File): Promise<void> => {
      setItems((prev) =>
        prev.map((item) =>
          item.localId === localId
            ? { ...item, status: 'uploading' as const, error: undefined }
            : item,
        ),
      );
      try {
        const uploaded = await uploadAttachment(sessionId, file);
        setItems((prev) =>
          prev.map((item) =>
            item.localId === localId
              ? {
                  ...item,
                  status: 'ready' as const,
                  id: uploaded.id,
                  mimeType: uploaded.mimeType,
                  error: undefined,
                }
              : item,
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setItems((prev) =>
          prev.map((item) =>
            item.localId === localId
              ? { ...item, status: 'failed' as const, error: message }
              : item,
          ),
        );
      }
    },
    [sessionId],
  );

  const add = useCallback(
    async (file: File): Promise<void> => {
      // Reject non-images before any network work — the server would 400
      // anyway, and an optimistic chip for an impossible upload is noise.
      if (!isImageFile(file)) return;

      const localId = nextLocalId();
      filesRef.current.set(localId, file);
      const previewUrl = URL.createObjectURL(file);
      setItems((prev) => [
        ...prev,
        {
          localId,
          status: 'uploading' as const,
          previewUrl,
          name: file.name,
          mimeType: file.type,
        },
      ]);
      await uploadOne(localId, file);
    },
    [uploadOne],
  );

  const remove = useCallback((localId: string): void => {
    const target = itemsRef.current.find((item) => item.localId === localId);
    if (target) URL.revokeObjectURL(target.previewUrl);
    filesRef.current.delete(localId);
    setItems((prev) => prev.filter((item) => item.localId !== localId));
  }, []);

  const retry = useCallback(
    async (localId: string): Promise<void> => {
      const file = filesRef.current.get(localId);
      if (!file) return;
      await uploadOne(localId, file);
    },
    [uploadOne],
  );

  const clear = useCallback((): void => {
    resetAll();
  }, [resetAll]);

  return { items, add, remove, retry, clear };
}
