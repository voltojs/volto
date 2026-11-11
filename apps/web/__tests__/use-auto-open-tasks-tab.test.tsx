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

  it('adopts restored tasks as the baseline on session switch without auto-open', () => {
    useSessionStore.setState({
      currentSessionId: 's1',
      sessions: [
        { id: 's1', detailLoaded: true },
        { id: 's2', detailLoaded: true },
      ] as never,
    });
    const { rerender } = renderHook(() => useAutoOpenTasksTab());
    // Session A accumulates two tasks (live 0 → 2 auto-opens).
    mockTasks.current = [item('a1'), item('a2')];
    rerender();
    expect(hasTasksTab()).toBe(true);

    // User closes, then switches to session C whose restored feed already
    // has one task. Entering a session must not pop the pane open: the
    // restored count becomes the baseline instead of an auto-open trigger.
    usePaneStore.getState().closeTab('tasks');
    mockTasks.current = [item('c1')];
    useSessionStore.setState({ currentSessionId: 's2' });
    rerender();
    expect(hasTasksTab()).toBe(false);

    // Live activity afterwards (dip to 0, then a fresh dispatch) still
    // auto-opens within the session being viewed.
    mockTasks.current = [];
    rerender();
    mockTasks.current = [item('c2')];
    rerender();
    expect(hasTasksTab()).toBe(true);
  });

  it('does not auto-open when the detail load restores tasks after a switch', () => {
    useSessionStore.setState({
      currentSessionId: 's1',
      sessions: [{ id: 's1', detailLoaded: false }] as never,
    });
    const { rerender } = renderHook(() => useAutoOpenTasksTab());
    // Switch clears the feed first; the restored batch lands with the detail.
    mockTasks.current = [];
    useSessionStore.setState({
      currentSessionId: 's2',
      sessions: [{ id: 's2', detailLoaded: false }] as never,
    });
    rerender();
    mockTasks.current = [item('r1')];
    useSessionStore.setState({
      sessions: [{ id: 's2', detailLoaded: true }] as never,
    });
    rerender();
    expect(hasTasksTab()).toBe(false);
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
