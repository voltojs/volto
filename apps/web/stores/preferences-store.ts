'use client';

import { create } from 'zustand';
import {
  EMPTY_PREFERENCES,
  fetchPreferences,
  patchPreferences,
  type Preferences,
} from '@/lib/preferences';

interface PreferencesState {
  preferences: Preferences;
  loaded: boolean;
  /** Fetches the stored defaults once; safe to call on every mount. */
  load: () => Promise<void>;
  /**
   * Records a user choice. Optimistic: the local copy updates immediately so a
   * new session created right after the click already uses it, and the write
   * is fire-and-forget — a failed save must not block the conversation.
   */
  save: (patch: Preferences) => void;
}

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  preferences: EMPTY_PREFERENCES,
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    try {
      const preferences = await fetchPreferences();
      set({ preferences, loaded: true });
    } catch {
      // Mark as loaded anyway: retrying on every mount would hammer a down
      // gateway, and the empty defaults are correct behaviour for one.
      set({ loaded: true });
    }
  },

  save: (patch) => {
    const next = { ...get().preferences, ...patch };
    set({ preferences: next });
    void patchPreferences(patch).catch(() => {
      // A preference that cannot be saved is not worth surfacing.
    });
  },
}));
