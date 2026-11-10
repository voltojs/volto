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

  it('does not show a folder icon on workspace rows', () => {
    seed({ ...base, sidebar: DEFAULT_SIDEBAR_STATE });
    render(<ProjectList />);
    expect(
      screen.getByTestId('project-row-p-1').querySelector('.lucide-folder-git-2'),
    ).toBeNull();
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

  it('shows one drag handle per workspace in manual order and none under a computed order', () => {
    seed({ ...base, sidebar: DEFAULT_SIDEBAR_STATE });
    const { unmount } = render(<ProjectList />);
    expect(screen.getAllByRole('button', { name: '拖动排序' })).toHaveLength(2);
    unmount();

    seed({
      ...base,
      sidebar: {
        ...DEFAULT_SIDEBAR_STATE,
        sortModes: { pinned: 'manual', projects: 'name' },
      },
    });
    render(<ProjectList />);
    expect(screen.queryAllByRole('button', { name: '拖动排序' })).toHaveLength(0);
  });

  it('keeps the visibly expanded first workspace open when a second one is expanded', async () => {
    seed({ ...base, sidebar: DEFAULT_SIDEBAR_STATE });
    render(<ProjectList />);
    expect(screen.getByText('s-under-p1-title')).toBeInTheDocument();

    await userEvent.click(screen.getByText('other'));

    expect(useSidebarStateStore.getState().state.expandedProjectIds).toEqual(['p-1', 'p-2']);
    expect(screen.getByText('s-under-p1-title')).toBeInTheDocument();
    expect(screen.getByText('s-under-p2-title')).toBeInTheDocument();
  });

  it('puts the drag handle in the chevron slot instead of adding its own', () => {
    seed({ ...base, sidebar: DEFAULT_SIDEBAR_STATE });
    render(<ProjectList />);
    const handle = screen.getAllByRole('button', { name: '拖动排序' })[0]!;
    // Same slot as the collapse chevron, so the name column does not move.
    expect(handle.parentElement?.querySelector('.lucide-chevron-right')).not.toBeNull();
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

  it('previews 5 sessions, then expands and collapses the rest on demand', async () => {
    const sessions = Array.from({ length: 7 }, (_, i) =>
      session({ id: `s-${i}`, projectId: 'p-1', updatedAt: i }),
    );
    seed({
      ...base,
      sessions,
      sidebar: { ...DEFAULT_SIDEBAR_STATE, expandedProjectIds: ['p-1'] },
    });
    render(<ProjectList />);
    // Only the preview shows; the remaining 2 wait behind a clickable row.
    for (let i = 0; i < 5; i += 1) {
      expect(screen.getByText(`s-${i}-title`)).toBeInTheDocument();
    }
    expect(screen.queryByText('s-5-title')).not.toBeInTheDocument();
    expect(screen.queryByText('s-6-title')).not.toBeInTheDocument();
    expect(screen.queryByText('收起')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '展开剩余 2 个会话' }));
    expect(screen.getByText('s-5-title')).toBeInTheDocument();
    expect(screen.getByText('s-6-title')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.queryByText('s-5-title')).not.toBeInTheDocument();
  });

  it('hides the expand row when a workspace has 5 or fewer sessions', () => {
    seed({ ...base, sidebar: DEFAULT_SIDEBAR_STATE });
    render(<ProjectList />);
    // Exact wording, not a bare /收起/: the workspace section header's own
    // collapse button is named 「收起工作区」 and must not be matched here.
    expect(
      screen.queryByRole('button', { name: /展开剩余 \d+ 个会话/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '收起' }),
    ).not.toBeInTheDocument();
  });
});