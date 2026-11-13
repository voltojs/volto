/**
 * File reference annotations per session (RowRefSet[], keyed by session id).
 * Mirrors the latest /file-refs fetch so chat rows can slice refs by row key;
 * values are replaced wholesale per session on each fetch.
 */

import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { RowRefSet } from '@voltojs/sdk/file-refs';

interface FileRefsState {
  bySession: Record<string, RowRefSet[]>;
  setFileRefs: (sessionId: string, refs: RowRefSet[]) => void;
}

export const useFileRefsStore: UseBoundStore<StoreApi<FileRefsState>> = create<FileRefsState>(
  (set) => ({
    bySession: {},
    setFileRefs: (sessionId, refs) =>
      set((state) => ({ bySession: { ...state.bySession, [sessionId]: refs } })),
  }),
);
