import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('lists pinned sessions in the stored manual order and labels their workspace', () => {
    seed(pinnedSeed);
    render(<PinnedList />);
    const titles = screen.getAllByText(/^s-[12]-title$/).map((n) => n.textContent);
    expect(titles).toEqual(['s-2-title', 's-1-title']);
    expect(screen.getAllByText('volto')).toHaveLength(2);
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
});