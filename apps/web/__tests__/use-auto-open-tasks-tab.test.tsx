// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoOpenTasksTab } from '@/hooks/use-auto-open-tasks-tab';
import { usePaneStore, PANE_WIDTH_DEFAULT } from '@/stores/pane-store';
import { useSessionStore } from '@/stores/session-store';
import type { BackgroundTaskItem } from '@/lib/background-tasks';

const mockTasks = vi.hoisted(() => ({ current: [] as BackgroundTaskItem[] }));

vi.mock('@/hooks/use-background-tasks', () => ({
  useBackgroundTasks: () => mockTasks.current,
}));

const item = (id: string): BackgroundTaskItem => ({
  id,
  childSessionId: id,
  title: id,
  status: 'running',
});

const hasTasksTab = () =>
  usePaneStore.getState().tabs.some((t) => t.kind === 'tasks');

describe('useAutoOpenTasksTab', () => {
  beforeEach(() => {
    mockTasks.current = [];
    usePaneStore.setState({
      tabs: [],
      activeTabId: null,
      width: PANE_WIDTH_DEFAULT,
      open: false,
      hidden: false,
    });
    useSessionStore.setState({ currentSessionId: 's1' });
  });

  it('opens the tasks tab on 0 → 1 transition when not already open', () => {
    const { rerender } = renderHook(() => useAutoOpenTasksTab());
    mockTasks.current = [item('a')];
    rerender();
    expect(hasTasksTab()).toBe(true);
  });

  it('does not re-open after the user closed the tab', () => {
    const { rerender } = renderHook(() => useAutoOpenTasksTab());
    mockTasks.current = [item('a')];
    rerender();
    usePaneStore.getState().closeTab('tasks');
    mockTasks.current = [item('a'), item('b')];
    rerender();
    expect(hasTasksTab()).toBe(false);
  });

  it('keeps the tab closed after user close even when count dips 1 → 0 → 1', () => {
    const { rerender } = renderHook(() => useAutoOpenTasksTab());
    mockTasks.current = [item('a')];
    rerender();
    expect(hasTasksTab()).toBe(true);

    usePaneStore.getState().closeTab('tasks');
    mockTasks.current = [];
    rerender();
    mockTasks.current = [item('b')];
    rerender();
    expect(hasTasksTab()).toBe(false);
  });

  it('resets the 0 → 1 baseline on session switch so restored tasks auto-open', () => {
    const { rerender } = renderHook(() => useAutoOpenTasksTab());
    // Session A accumulates two tasks (prevCount lands on 2).
    mockTasks.current = [item('a1'), item('a2')];
    rerender();
    expect(hasTasksTab()).toBe(true);

    // User closes, then switches to session C whose restored feed already
    // has one task. Without a session-scoped reset this looks like 2 → 1
    // and auto-open never fires.
    usePaneStore.getState().closeTab('tasks');
    mockTasks.current = [item('c1')];
    useSessionStore.setState({ currentSessionId: 's2' });
    rerender();
    expect(hasTasksTab()).toBe(true);
  });

  it('does not force-activate when the tab is already open', () => {
    usePaneStore.setState({
      tabs: [
        { kind: 'tasks', id: 'tasks' },
        { kind: 'files', id: 'files:p1', projectId: 'p1' },
      ],
      activeTabId: 'files:p1',
      open: true,
    });
    mockTasks.current = [];
    const { rerender } = renderHook(() => useAutoOpenTasksTab());
    mockTasks.current = [item('a')];
    rerender();
    expect(usePaneStore.getState().activeTabId).toBe('files:p1');
  });
});
