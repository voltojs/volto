// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoOpenTasksTab } from '@/hooks/use-auto-open-tasks-tab';
import { usePaneStore, PANE_WIDTH_DEFAULT } from '@/stores/pane-store';
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
  });

  it('opens the tasks tab on 0 → 1 transition when not already open', () => {
    const { rerender } = renderHook(() => useAutoOpenTasksTab());
    mockTasks.current = [item('a')];
    rerender();
    expect(
      usePaneStore.getState().tabs.some((t) => t.kind === 'tasks'),
    ).toBe(true);
  });

  it('does not re-open after the user closed the tab', () => {
    const { rerender } = renderHook(() => useAutoOpenTasksTab());
    mockTasks.current = [item('a')];
    rerender();
    usePaneStore.getState().closeTab('tasks');
    mockTasks.current = [item('a'), item('b')];
    rerender();
    expect(
      usePaneStore.getState().tabs.some((t) => t.kind === 'tasks'),
    ).toBe(false);
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
