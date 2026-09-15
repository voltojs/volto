// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BackgroundTasksTab } from '@/components/pane/BackgroundTasksTab';
import { usePaneStore, PANE_WIDTH_DEFAULT } from '@/stores/pane-store';
import { useBackgroundTasks } from '@/hooks/use-background-tasks';

vi.mock('@/hooks/use-background-tasks', () => ({
  useBackgroundTasks: vi.fn(),
}));

describe('BackgroundTasksTab', () => {
  beforeEach(() => {
    usePaneStore.setState({
      tabs: [],
      activeTabId: null,
      width: PANE_WIDTH_DEFAULT,
      open: false,
      hidden: false,
    });
    vi.mocked(useBackgroundTasks).mockReturnValue([]);
  });

  it('renders the empty state', () => {
    render(<BackgroundTasksTab tab={{ kind: 'tasks', id: 'tasks' }} />);
    expect(screen.getByText('当前对话暂无后台任务')).toBeDefined();
  });

  it('opens the subagent chat tab when a row is clicked', () => {
    vi.mocked(useBackgroundTasks).mockReturnValue([
      {
        id: 'c1',
        childSessionId: 's-sub-0',
        title: 'explore codebase',
        status: 'running',
        startedAt: Date.now() - 1000,
      },
    ]);
    render(<BackgroundTasksTab tab={{ kind: 'tasks', id: 'tasks' }} />);
    fireEvent.click(screen.getByRole('button', { name: /explore codebase/ }));
    expect(usePaneStore.getState().tabs).toContainEqual({
      kind: 'subagent',
      id: 'subagent:s-sub-0',
      childSessionId: 's-sub-0',
      view: 'chat',
    });
    expect(usePaneStore.getState().activeTabId).toBe('subagent:s-sub-0');
  });

  it('marks error rows with destructive class and shows duration', () => {
    vi.mocked(useBackgroundTasks).mockReturnValue([
      {
        id: 'c1',
        childSessionId: 'x',
        title: 'fail',
        status: 'error',
        durationMs: 120,
      },
    ]);
    const { container } = render(
      <BackgroundTasksTab tab={{ kind: 'tasks', id: 'tasks' }} />,
    );
    expect(container.querySelector('.text-destructive')).not.toBeNull();
    expect(screen.getByText('120ms')).toBeDefined();
  });
});
