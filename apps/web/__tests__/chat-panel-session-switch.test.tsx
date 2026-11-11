/**
 * Session switch vs the right pane: entering another conversation must
 * collapse the pane and drop the previous session's session-scoped tabs
 * (subagent / plan), while workspace tabs survive for the next manual open.
 * Restored history (tasks / plan turn-end) must not pop the pane back open;
 * live turn-ends inside the viewed session still may.
 *
 * Same minimal harness as chat-panel-plan.test.tsx: render ChatPanel itself,
 * mock only network-shaped hooks and the pane body.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { usePaneStore } from '@/stores/pane-store';
import { useConfigStore } from '@/stores/config-store';
import type { TranscriptEventInput } from '@volto/sdk/sse';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  fetchPlan: vi.fn(),
}));

vi.mock('@/hooks/use-chat-agent', () => ({
  useChatAgent: () => ({
    sendMessage: mocks.sendMessage,
    stopGeneration: vi.fn(),
    connectionState: 'connected',
    getApprovalToken: () => null,
  }),
}));

vi.mock('@/hooks/use-conversation', () => ({
  useConversation: () => ({ entries: [], usage: null, messages: [] }),
}));

vi.mock('@/hooks/use-auto-open-tasks-tab', () => ({
  useAutoOpenTasksTab: () => {},
}));

vi.mock('@/hooks/use-add-project', () => ({
  useAddProject: () => ({ run: vi.fn(async () => null), pending: false }),
}));

vi.mock('@/hooks/use-server-sessions', () => ({
  ensureSessionDetail: vi.fn(async () => {}),
  needsQueueResync: vi.fn(() => false),
}));

vi.mock('@/lib/sessions-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPlan: mocks.fetchPlan,
  fetchServerTrajectory: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/components/pane/RightPane', () => ({
  RightPane: () => <div data-testid="stub-right-pane" />,
}));

const session = (id: string, permissionMode: 'plan' | 'ask' = 'ask') => ({
  id,
  title: id,
  messages: [],
  messageCount: 0,
  detailLoaded: true,
  createdAt: 0,
  updatedAt: 0,
  projectId: 'p1',
  providerId: 'prov1',
  modelId: 'm1',
  permissionMode,
});

function seedTwoSessions() {
  useSessionStore.setState({
    currentSessionId: 's1',
    planPreviousMode: null,
    sessions: [session('s1'), session('s2')],
  } as never);
}

function openWorkspaceAndSubagentTabs() {
  act(() => {
    usePaneStore.getState().openTab({ kind: 'files', id: 'files:p1', projectId: 'p1' });
    usePaneStore.getState().openTab({
      kind: 'subagent',
      id: 'subagent:child-1',
      childSessionId: 'child-1',
      view: 'chat',
      parentSessionId: 's1',
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useChatStore.getState().clear();
  usePaneStore.setState({
    tabs: [],
    activeTabId: null,
    open: false,
    hidden: false,
    snapshots: {},
    activeSessionKey: null,
  });
  useConfigStore.setState({ projects: [], providers: [] });
  seedTwoSessions();
});

describe('ChatPanel — per-session right-pane memory', () => {
  it('switching to a never-seen session collapses empty; returning restores the left pane', () => {
    render(<ChatPanel />);
    openWorkspaceAndSubagentTabs();
    expect(usePaneStore.getState().hidden).toBe(false);

    act(() => {
      useSessionStore.setState({ currentSessionId: 's2' });
    });
    const switched = usePaneStore.getState();
    expect(switched.hidden).toBe(true);
    expect(switched.tabs).toEqual([]);

    // Manual expand in s2 must not show s1's subagent tab.
    act(() => {
      usePaneStore.getState().setHidden(false);
    });
    expect(usePaneStore.getState().tabs.some((t) => t.kind === 'subagent')).toBe(false);

    // Returning to s1 restores its own tabs and expanded state.
    act(() => {
      useSessionStore.setState({ currentSessionId: 's1' });
    });
    const back = usePaneStore.getState();
    expect(back.hidden).toBe(false);
    expect(back.tabs).toEqual([
      { kind: 'files', id: 'files:p1', projectId: 'p1' },
      {
        kind: 'subagent',
        id: 'subagent:child-1',
        childSessionId: 'child-1',
        view: 'chat',
        parentSessionId: 's1',
      },
    ]);
  });

  it('starting a new conversation (null) collapses; the left session is remembered', () => {
    render(<ChatPanel />);
    openWorkspaceAndSubagentTabs();

    act(() => {
      useSessionStore.setState({ currentSessionId: null });
    });
    const s = usePaneStore.getState();
    expect(s.hidden).toBe(true);
    expect(s.tabs).toEqual([]);

    act(() => {
      useSessionStore.setState({ currentSessionId: 's1' });
    });
    expect(usePaneStore.getState().tabs.some((t) => t.kind === 'subagent')).toBe(true);
  });

  it('remount (refresh) restores the current session pane from its snapshot', () => {
    const first = render(<ChatPanel />);
    openWorkspaceAndSubagentTabs();
    first.unmount();

    // Simulate a fresh page life: live tabs reset, snapshots persist in memory.
    usePaneStore.setState({ tabs: [], activeTabId: null, open: false, hidden: false, activeSessionKey: null });
    render(<ChatPanel />);
    const s = usePaneStore.getState();
    expect(s.tabs.some((t) => t.kind === 'subagent')).toBe(true);
    expect(s.hidden).toBe(false);
  });

  it('restored plan history on switch does not re-open the pane; a live turn-end does', async () => {
    mocks.fetchPlan.mockResolvedValue({ content: '# plan\n', updatedAt: 1 });
    useSessionStore.setState({
      sessions: [session('s1'), session('s2', 'plan')],
    } as never);
    render(<ChatPanel />);

    act(() => {
      useSessionStore.setState({ currentSessionId: 's2' });
    });
    // Entering the plan session adopts its restored state as baseline.
    expect(usePaneStore.getState().hidden).toBe(true);
    expect(usePaneStore.getState().tabs).toEqual([]);

    // A live turn-end inside the viewed session still auto-opens the plan.
    const event: TranscriptEventInput = {
      time: 1,
      type: 'turn_end',
      data: { turn: 1, reason: 'done' },
    };
    await act(async () => {
      useChatStore.setState({ events: [event], deltas: [] });
    });
    const s = usePaneStore.getState();
    expect(s.tabs).toContainEqual({ kind: 'plan', id: 's2', sessionId: 's2' });
    expect(s.hidden).toBe(false);
  });
});
