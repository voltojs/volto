import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PinnedList } from '../PinnedList';
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

function project(id: string, name: string) {
  return { id, name, path: `/tmp/${id}`, createdAt: 1 };
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

const pinnedSeed = {
  sessions: [
    session({ id: 's-1', projectId: 'p-1', updatedAt: 100 }),
    session({ id: 's-2', projectId: 'p-1', updatedAt: 300 }),
    session({ id: 's-3', projectId: 'p-1', updatedAt: 200 }),
  ],
  projects: [project('p-1', 'volto')],
  sidebar: { ...DEFAULT_SIDEBAR_STATE, pinnedSessionIds: ['s-2', 's-1'] },
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  useSidebarStateStore.setState({ state: DEFAULT_SIDEBAR_STATE, loaded: false });
});

describe('PinnedList', () => {
  it('renders nothing when no session is pinned', () => {
    seed({
      sessions: [session({ id: 's-1', projectId: 'p-1' })],
      projects: [project('p-1', 'volto')],
      sidebar: DEFAULT_SIDEBAR_STATE,
    });
    render(<PinnedList />);
    expect(screen.queryByText('置顶')).not.toBeInTheDocument();
  });

  it('lists pinned sessions in the stored manual order without an inline workspace label', () => {
    seed(pinnedSeed);
    render(<PinnedList />);
    const titles = screen.getAllByText(/^s-[12]-title$/).map((n) => n.textContent);
    expect(titles).toEqual(['s-2-title', 's-1-title']);
    // The workspace name is not part of the row; it lives in the tooltip.
    expect(screen.queryByText('volto')).not.toBeInTheDocument();
  });

  it('shows the workspace name in the row tooltip in small type', async () => {
    seed(pinnedSeed);
    render(<PinnedList />);
    await userEvent.hover(screen.getAllByText(/^s-[12]-title$/)[0]!);
    await waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-content"]')).not.toBeNull(),
    );
    const tooltip = within(
      document.querySelector('[data-slot="tooltip-content"]') as HTMLElement,
    );
    expect(tooltip.getByText('volto')).toBeInTheDocument();
  });

  it('opens a pinned session and adds its project to the expanded set without expanding a collapsed section', async () => {
    seed({
      ...pinnedSeed,
      sessions: [session({ id: 's-1', projectId: 'p-2' })],
      projects: [project('p-1', 'volto'), project('p-2', 'other')],
      sidebar: {
        ...DEFAULT_SIDEBAR_STATE,
        pinnedSessionIds: ['s-1'],
        projectsCollapsed: true,
      },
    });
    render(<PinnedList />);
    await userEvent.click(screen.getByText('s-1-title'));
    expect(useSessionStore.getState().currentSessionId).toBe('s-1');
    // The default-expanded first workspace stays open; the session's own
    // workspace is added beside it.
    expect(useSidebarStateStore.getState().state.expandedProjectIds).toEqual(['p-1', 'p-2']);
    expect(useSidebarStateStore.getState().state.projectsCollapsed).toBe(true);
  });

  it('keeps the default-expanded first workspace when opening a pinned session from another one', async () => {
    seed({
      sessions: [
        session({ id: 's-1', projectId: 'p-1' }),
        session({ id: 's-pin', projectId: 'p-2' }),
      ],
      projects: [project('p-1', 'volto'), project('p-2', 'other')],
      sidebar: { ...DEFAULT_SIDEBAR_STATE, pinnedSessionIds: ['s-pin'] },
    });
    render(<PinnedList />);
    await userEvent.click(screen.getByText('s-pin-title'));
    expect(useSidebarStateStore.getState().state.expandedProjectIds).toEqual(['p-1', 'p-2']);
  });

  it('persists collapse and sort changes', async () => {
    seed(pinnedSeed);
    render(<PinnedList />);
    await userEvent.click(screen.getByRole('button', { name: '收起置顶' }));
    expect(useSidebarStateStore.getState().state.pinnedCollapsed).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '排序方式' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: '最近活跃' }));
    expect(useSidebarStateStore.getState().state.sortModes.pinned).toBe('recent');
  });

  it('reorders by activity once the sort mode is recent', () => {
    seed({
      ...pinnedSeed,
      sidebar: {
        ...pinnedSeed.sidebar,
        sortModes: { pinned: 'recent', projects: 'manual' },
      },
    });
    render(<PinnedList />);
    const titles = screen.getAllByText(/^s-[12]-title$/).map((n) => n.textContent);
    expect(titles).toEqual(['s-2-title', 's-1-title']);
  });

  it('shows one drag handle per row in manual order and none under a computed order', () => {
    seed(pinnedSeed);
    const { unmount } = render(<PinnedList />);
    expect(screen.getAllByRole('button', { name: '拖动排序' })).toHaveLength(2);
    unmount();

    seed({
      ...pinnedSeed,
      sidebar: {
        ...pinnedSeed.sidebar,
        sortModes: { pinned: 'recent', projects: 'manual' },
      },
    });
    render(<PinnedList />);
    expect(screen.queryAllByRole('button', { name: '拖动排序' })).toHaveLength(0);
  });

  it('unpins a row without opening it', async () => {
    seed(pinnedSeed);
    render(<PinnedList />);
    await userEvent.hover(screen.getAllByText(/^s-[12]-title$/)[0]!);
    await userEvent.click(screen.getAllByRole('button', { name: '取消置顶' })[0]!);
    expect(useSidebarStateStore.getState().state.pinnedSessionIds).toEqual(['s-1']);
    expect(useSessionStore.getState().currentSessionId).toBeNull();
  });

  it('previews 5 pinned sessions, then expands and collapses the rest on demand', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `s-${i}`);
    seed({
      sessions: ids.map((id, i) =>
        session({ id, projectId: 'p-1', updatedAt: i }),
      ),
      projects: [project('p-1', 'volto')],
      sidebar: { ...DEFAULT_SIDEBAR_STATE, pinnedSessionIds: ids },
    });
    render(<PinnedList />);
    for (let i = 0; i < 5; i += 1) {
      expect(screen.getByText(`s-${i}-title`)).toBeInTheDocument();
    }
    expect(screen.queryByText('s-5-title')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '展开剩余 2 个会话' }));
    expect(screen.getByText('s-5-title')).toBeInTheDocument();
    expect(screen.getByText('s-6-title')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.queryByText('s-5-title')).not.toBeInTheDocument();
  });

  it('hides the pinned expand row when 5 or fewer sessions are pinned', () => {
    seed(pinnedSeed);
    render(<PinnedList />);
    expect(
      screen.queryByRole('button', { name: /展开剩余 \d+ 个会话/ }),
    ).not.toBeInTheDocument();
  });
});