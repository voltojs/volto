'use client';

import { useEffect, useRef } from 'react';
import { useBackgroundTasks } from '@/hooks/use-background-tasks';
import { useSessionStore } from '@/stores/session-store';
import { openTasksTab, usePaneStore } from '@/stores/pane-store';

/**
 * Open the singleton tasks tab once per session when the current session's
 * background task count crosses 0 → ≥1. Auto-open is sticky per session:
 * after the first 0 → ≥1 opportunity is consumed, a user close stays closed
 * for the rest of the session (including 1 → 0 → 1 dips).
 *
 * Entering a session (mount or switch) never auto-opens: the first feed
 * observed once the session detail has loaded is restored history, adopted
 * as the count baseline without opening. Only rises observed afterwards
 * (live dispatches while staying in the session) may auto-open, so switching
 * conversations cannot pop the pane open on its own. An already-open tab is
 * left untouched so the user is not yanked off files/git.
 */
export function useAutoOpenTasksTab(): void {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const detailLoaded = useSessionStore(
    (s) => s.sessions.find((x) => x.id === s.currentSessionId)?.detailLoaded ?? false,
  );
  const tasks = useBackgroundTasks();
  const count = tasks.length;
  const prevCountRef = useRef(0);
  const autoOpenedRef = useRef(false);
  const sessionIdRef = useRef(currentSessionId);
  const loadedRef = useRef(false);

  useEffect(() => {
    // ChatPanel does not remount on session switch, so reset the baseline
    // and sticky flag here — otherwise the prior session's count leaks into
    // the new session's transition detection.
    if (sessionIdRef.current !== currentSessionId) {
      sessionIdRef.current = currentSessionId;
      prevCountRef.current = 0;
      autoOpenedRef.current = false;
      loadedRef.current = false;
    }

    // First loaded observation per session = restored history: adopt it as
    // the baseline and skip auto-open so a switch never reveals the pane.
    if (detailLoaded && !loadedRef.current) {
      loadedRef.current = true;
      prevCountRef.current = count;
      return;
    }
    loadedRef.current = detailLoaded;

    const prev = prevCountRef.current;
    prevCountRef.current = count;
    if (prev !== 0 || count < 1) return;
    // Consume the per-session auto-open opportunity even if the tab is
    // already open, so a later user close cannot be undone by a 1 → 0 → 1.
    if (autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    if (usePaneStore.getState().tabs.some((t) => t.kind === 'tasks')) return;
    openTasksTab();
  }, [count, currentSessionId, detailLoaded]);
}
