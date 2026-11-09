'use client';

/**
 * The sidebar's layout document, mirrored locally so pinning, collapsing and
 * dragging feel instant.
 *
 * Two rules make it safe on top of an optimistic copy:
 * - Writes are serialised and only the newest document is sent. Two fast drags
 *   must not race, and a queued write must never send a stale order.
 * - Nothing is written before `load()` settles. The optimistic copy starts as
 *   the default layout, so an early write would overwrite the document the
 *   server already holds.
 */

import { create } from 'zustand';
import {
  DEFAULT_SIDEBAR_STATE,
  fetchSidebarState,
  putSidebarState,
  type SidebarState,
} from '@/lib/sidebar-state-api';

interface SidebarStateStore {
  state: SidebarState;
  /** True once the server document (or the default on failure) is in memory. */
  loaded: boolean;
  /** Fetches the stored layout once; safe to call on every mount. */
  load: () => Promise<void>;
  /**
   * Records a layout change: applied locally immediately, persisted in the
   * background. A failed save is not worth surfacing — the next change
   * carries the whole document anyway.
   */
  update: (updater: (current: SidebarState) => SidebarState) => void;
}

export const useSidebarStateStore = create<SidebarStateStore>()((set, get) => {
  /** Newest document awaiting a PUT; null when nothing is pending. */
  let pending: SidebarState | null = null;
  /** True while one PUT is in flight. */
  let saving = false;
  /** In-flight `load()` so concurrent mounts share one request. */
  let loading: Promise<void> | null = null;

  async function flush(): Promise<void> {
    // Writes before the server document is in memory would clobber it.
    if (saving || !get().loaded) return;
    while (pending !== null) {
      const snapshot = pending;
      pending = null;
      saving = true;
      try {
        await putSidebarState(snapshot);
      } catch {
        // `putSidebarState` reports failure as `false`; this only guards a
        // future implementation that throws.
      } finally {
        saving = false;
      }
    }
  }

  return {
    state: DEFAULT_SIDEBAR_STATE,
    loaded: false,

    load: async () => {
      if (get().loaded) return;
      if (loading !== null) return loading;
      loading = (async () => {
        const state = await fetchSidebarState();
        set({ state, loaded: true });
        loading = null;
        // Anything the user changed before the load landed is still pending.
        await flush();
      })();
      return loading;
    },

    update: (updater) => {
      const next = updater(get().state);
      set({ state: next });
      pending = next;
      void flush();
    },
  };
});