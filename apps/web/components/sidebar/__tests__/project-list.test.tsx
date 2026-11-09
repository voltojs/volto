import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectList } from '../ProjectList';
import { useSessionStore, type Session } from '@/stores/session-store';
import { useConfigStore } from '@/stores/config-store';
import { useSidebarStateStore } from '@/stores/sidebar-state-store';
import { DEFAULT_SIDEBAR_STATE, type SidebarState } from '@/lib/sidebar-state-api';

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

function session(overrides: Partial<Session> & { id: string; projectId: string | null }): Session {
  return {
    title: `${overrides.id}-title`,
    messages: [],
    messageCount: 0,
    detailLoaded: true,
    createdAt: 1,
    updatedAt: 1,
    providerId: null,
    modelId: null,
    permissionMode: 'ask',
    ...overrides,
  } as Session;
}

function project(id: string, name: string, createdAt = 1) {
  return { id, name, path: `/tmp/${id}`, createdAt };
}

function seed(options: {
  sessions: Session[];
  projects: ReturnType<typeof project>[];
  sidebar: SidebarState;
}) {
  useSessionStore.setState({ sessions: options.sessions, currentSessionId: null });
  useConfigStore.setState({ projects: options.projects });
  useSidebarStateStore.setState({ state: options.sidebar, loaded: true });
}

const base = {
  sessions: [
    session({ id: 's-under-p1', projectId: 'p-1', updatedAt: 100 }),
    session({ id: 's-under-p2', projectId: 'p-2', updatedAt: 200 }),
    session({ id: 's-pinned', projectId: 'p-1', updatedAt: 300 }),
  ],
  projects: [project('p-1', 'volto', 10), project('p-2', 'other', 20)],
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  useSidebarStateStore.setState({ state: DEFAULT_SIDEBAR_STATE, loaded: false });
});

describe('ProjectList', () => {
  it('expands several projects at once from the stored set', () => {
    seed({
      ...base,
      sidebar: { ...DEFAULT_SIDEBAR_STATE, expandedProjectIds: ['p-1', 'p-2'] },
    });
    render(<ProjectList />);
    expect(screen.getByText('s-under-p1-title')).toBeInTheDocument();
    expect(screen.getByText('s-under-p2-title')).toBeInTheDocument();
  });

  it('defaults to the first project when the key is absent, and stays fully collapsed for []', () => {
    seed({ ...base, sidebar: DEFAULT_SIDEBAR_STATE });
    const { unmount } = render(<ProjectList />);
    expect(screen.getByText('s-under-p1-title')).toBeInTheDocument();
    unmount();

    seed({ ...base, sidebar: { ...DEFAULT_SIDEBAR_STATE, expandedProjectIds: [] } });
    render(<ProjectList />);
    expect(screen.queryByText('s-under-p1-title')).not.toBeInTheDocument();
  });

  it('keeps pinned sessions out of the workspace rows but counts them', () => {
    seed({
      ...base,
      sidebar: {
        ...DEFAULT_SIDEBAR_STATE,
        pinnedSessionIds: ['s-pinned'],
        expandedProjectIds: ['p-1'],
      },
    });
    render(<ProjectList />);
    expect(screen.queryByText('s-pinned-title')).not.toBeInTheDocument();
    // The count still reports every session in the workspace (2), pinned included.
    expect(
      within(screen.getByTestId('project-row-p-1')).getByText('2'),
    ).toBeInTheDocument();
  });

  it('reorders projects by the chosen sort mode', async () => {
    seed({ ...base, sidebar: DEFAULT_SIDEBAR_STATE });
    render(<ProjectList />);
    await userEvent.click(screen.getByRole('button', { name: '排序方式' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: '名称' }));
    expect(useSidebarStateStore.getState().state.sortModes.projects).toBe('name');
    const rows = screen.getAllByText(/^(volto|other)$/).map((n) => n.textContent);
    expect(rows).toEqual(['other', 'volto']); // localeCompare: other < volto
  });

  it('collapses the whole section and reopens it', async () => {
    seed({ ...base, sidebar: { ...DEFAULT_SIDEBAR_STATE, projectsCollapsed: true } });
    render(<ProjectList />);
    // jsdom loads no stylesheet, so `toBeVisible` cannot see Tailwind's
    // `hidden`; assert the class the browser acts on instead.
    const rows = screen.getByTestId('workspace-rows');
    expect(rows).toHaveClass('hidden');
    await userEvent.click(screen.getByRole('button', { name: '展开工作区' }));
    expect(useSidebarStateStore.getState().state.projectsCollapsed).toBe(false);
    expect(screen.getByTestId('workspace-rows')).not.toHaveClass('hidden');
  });

  it('writes an explicit [] when the last expanded project is collapsed', async () => {
    seed({
      ...base,
      sidebar: { ...DEFAULT_SIDEBAR_STATE, expandedProjectIds: ['p-1'] },
    });
    render(<ProjectList />);
    await userEvent.click(screen.getByText('volto'));
    expect(useSidebarStateStore.getState().state.expandedProjectIds).toEqual([]);
  });
});