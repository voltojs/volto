'use client';

import { useEffect, useRef } from 'react';
import { useBackgroundTasks } from '@/hooks/use-background-tasks';
import { openTasksTab, usePaneStore } from '@/stores/pane-store';

/**
 * Open the singleton tasks tab once when the current session's background
 * task count crosses 0 → ≥1. Closing the tab is sticky for the rest of the
 * session (later arrivals do not re-open). An already-open tab is left
 * untouched so the user is not yanked off files/git.
 */
export function useAutoOpenTasksTab(): void {
  const tasks = useBackgroundTasks();
  const count = tasks.length;
  const prevCountRef = useRef(0);

  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = count;
    if (prev !== 0 || count < 1) return;
    if (usePaneStore.getState().tabs.some((t) => t.kind === 'tasks')) return;
    openTasksTab();
  }, [count]);
}
