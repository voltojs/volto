'use client';

import { useEffect, useRef } from 'react';
import { useBackgroundTasks } from '@/hooks/use-background-tasks';
import { useSessionStore } from '@/stores/session-store';
import { openTasksTab, usePaneStore } from '@/stores/pane-store';

/**
 * Open the singleton tasks tab once per session when the current session's
 * background task count crosses 0 → ≥1. Auto-open is sticky per session:
 * after the first 0 → ≥1 opportunity is consumed, a user close stays closed
 * for the rest of the session (including 1 → 0 → 1 dips). Switching
 * `currentSessionId` resets both the count baseline and the sticky flag, so
 * a new session whose restored tasks land at count ≥ 1 still auto-opens.
 * An already-open tab is left untouched so the user is not yanked off
 * files/git.
 */
export function useAutoOpenTasksTab(): void {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const tasks = useBackgroundTasks();
  const count = tasks.length;
  const prevCountRef = useRef(0);
  const autoOpenedRef = useRef(false);
  const sessionIdRef = useRef(currentSessionId);

  useEffect(() => {
    // ChatPanel does not remount on session switch, so reset the baseline
    // and sticky flag here — otherwise the prior session's count makes a
    // restored 0 → ≥1 look like a non-transition and auto-open never fires.
    if (sessionIdRef.current !== currentSessionId) {
      sessionIdRef.current = currentSessionId;
      prevCountRef.current = 0;
      autoOpenedRef.current = false;
    }

    const prev = prevCountRef.current;
    prevCountRef.current = count;
    if (prev !== 0 || count < 1) return;
    // Consume the per-session auto-open opportunity even if the tab is
    // already open, so a later user close cannot be undone by a 1 → 0 → 1.
    if (autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    if (usePaneStore.getState().tabs.some((t) => t.kind === 'tasks')) return;
    openTasksTab();
  }, [count, currentSessionId]);
}
