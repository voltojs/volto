/**
 * ChatPanel layout contract: the conversation-mode InputBar lives outside the
 * thread scroller (which the panel owes a full-width layer) but inside the
 * chat TabsContent panel as its own column, not as a page footer sibling of
 * the row that holds Tabs + RightPane. Trajectory tab must not host the main
 * input.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { usePaneStore, PANE_WIDTH_DEFAULT } from '@/stores/pane-store';
import { useConfigStore, type Provider } from '@/stores/config-store';

vi.mock('@/lib/sessions-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sessions-api')>();
  return {
    ...actual,
    fetchSessionEvents: vi
      .fn()
      .mockResolvedValue({ sessionId: 'x', events: [] }),
    fetchServerSessionDetail: vi.fn().mockResolvedValue({
      messages: [],
      contextUsage: null,
      projectId: 'p1',
      providerId: 'v1',
      modelId: 'm1',
      permissionMode: 'ask',
    }),
    renameServerSession: vi.fn().mockResolvedValue({}),
    // The bottom status bar folds trajectory rows; keep tests offline.
    fetchServerTrajectory: vi.fn().mockResolvedValue(null),
  };
});
vi.mock('@/lib/git-api', () => ({
  fetchGitSummary: vi
    .fn()
    .mockResolvedValue({ isGit: false, branch: null, head: null }),
}));
vi.mock('@/lib/agent-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent-config')>();
  return {
    ...actual,
    createGatewaySSEClient: () => {
      const stateHandlers: Array<(state: string) => void> = [];
      return {
        onStateChange: (cb: (state: string) => void) => {
          stateHandlers.push(cb);
          return () => {};
        },
        onEvent: vi.fn(),
        onDelta: vi.fn(),
        onError: vi.fn(),
        destroy: vi.fn(),
        setEventSourceFactory: vi.fn(),
        getConnectionToken: () => null,
        connect: () => {
          for (const cb of stateHandlers) cb('connected');
        },
      };
    },
    postMessage: vi.fn(async () => {}),
    interruptTurn: vi.fn(async () => true),
  };
});

// jsdom lacks Range layout APIs tiptap/prosemirror touch on focus paths.
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  const emptyRectList: DOMRectList = Object.assign([] as DOMRect[], {
    item: () => null,
  });
  Range.prototype.getClientRects = () => emptyRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.setPointerCapture ??= () => {};

const PROVIDER: Provider = {
  kind: 'custom',
  id: 'v1',
  name: 'Xiaomi',
  baseURL: 'https://example.com/v1',
  apiKeyMasked: null,
  models: [{ id: 'm1', name: 'MiMo', code: 'mimo' }],
};

describe('ChatPanel input layout', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useChatStore.setState({
      events: [],
      deltas: [],
      isGenerating: false,
      subagents: {},
      currentSessionId: 's1',
      connectionState: 'connected',
    });
    usePaneStore.setState({
      tabs: [],
      activeTabId: null,
      width: PANE_WIDTH_DEFAULT,
      open: true,
      hidden: false,
      snapshots: {},
      activeSessionKey: null,
    });
    useConfigStore.setState({
      projects: [{ id: 'p1', path: '/tmp/p1', name: 'p1', createdAt: 0 }],
      providers: [PROVIDER],
      catalogProviders: [],
      loaded: true,
      error: null,
    });
    useSessionStore.setState({
      currentSessionId: 's1',
      sidebarOpen: false,
      pendingProjectId: null,
      sessions: [
        {
          id: 's1',
          title: 't',
          // One stored message so the conversation branch (not welcome /
          // skeleton) renders the main InputBar.
          messages: [
            {
              id: 'um1',
              role: 'user',
              blocks: [{ type: 'text', text: 'hello' }],
              content: 'hello',
              timestamp: 0,
            },
          ],
          messageCount: 1,
          detailLoaded: true,
          projectId: 'p1',
          providerId: 'v1',
          modelId: 'm1',
          permissionMode: 'ask',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
  });

  it('renders the main input inside the chat column, not as a page-footer sibling of RightPane', () => {
    const { container } = render(<ChatPanel />);

    const pane = container.querySelector('[data-testid="right-pane"]');
    expect(pane).not.toBeNull();

    const editor = container.querySelector('[data-testid="input-editor"]');
    expect(editor).not.toBeNull();

    // RightPane's parent is the main content row. After the move the chat
    // TabsContent column (and thus the editor) is inside that row; before
    // the move the editor sits outside it as a page-level sibling.
    const row = pane!.parentElement;
    expect(row).not.toBeNull();
    expect(row!.contains(editor!)).toBe(true);

    // InputBar must live in a TabsContent panel, and that panel must not be
    // the trajectory one (keepMounted leaves both panels in the DOM).
    const editorPanel = editor!.closest('[data-slot="tabs-content"]');
    expect(editorPanel).not.toBeNull();
    const panels = container.querySelectorAll('[data-slot="tabs-content"]');
    expect(panels.length).toBeGreaterThanOrEqual(2);
    for (const panel of panels) {
      if (panel === editorPanel) continue;
      expect(panel.contains(editor!)).toBe(false);
    }

    // The thread scrolls in a full-width layer, and the widened column sits
    // inside it: a scrollbar on the column itself would straddle the column
    // edge instead of the pane edge.
    const scroll = editorPanel!.querySelector('[data-testid="chat-scroll"]');
    expect(scroll).not.toBeNull();
    expect(scroll!.className).toContain('overflow-y-auto');

    // The composer column is the scroller's sibling, so the input never
    // scrolls away with the thread.
    expect(scroll!.contains(editor!)).toBe(false);

    // Both columns share one width class (no per-surface max widths).
    const threadColumn = scroll!.querySelector('.max-w-7xl');
    const composerColumn = editor!.closest('.max-w-7xl');
    expect(threadColumn).not.toBeNull();
    expect(composerColumn).not.toBeNull();
    expect(composerColumn).not.toBe(threadColumn);
    expect(composerColumn!.className).toBe(threadColumn!.className);
  });

  it('places the right pane at equal standing with the content column', () => {
    const { container } = render(<ChatPanel />);
    const pane = container.querySelector('[data-testid="right-pane"]');
    const header = container.querySelector('header');
    expect(pane).not.toBeNull();
    expect(header).not.toBeNull();
    // Both columns hang off the same top-level row: the pane is a sibling of
    // the content column that owns the title bar — not stacked below a
    // full-width header.
    expect(header!.parentElement?.parentElement).toBe(pane!.parentElement);
  });

  it('hosts the three-module status bar right under the input', () => {
    const { container } = render(<ChatPanel />);

    const bar = container.querySelector('[data-testid="chat-status-bar"]');
    expect(bar).not.toBeNull();

    // Inside the chat column, below the editor.
    const editor = container.querySelector('[data-testid="input-editor"]')!;
    const editorPanel = editor.closest('[data-slot="tabs-content"]')!;
    expect(editorPanel.contains(bar)).toBe(true);
    expect(
      editor.compareDocumentPosition(bar!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);

    // All three modules: session stats, whole-conversation usage, context ring.
    expect(bar!.querySelector('[aria-label="会话统计"]')).not.toBeNull();
    expect(bar!.querySelector('[aria-label="整个对话用量"]')).not.toBeNull();
    // The ring itself unmounts while no usage is projected; the slot marks
    // that the third module is wired into the bar either way.
    expect(
      bar!.querySelector('[data-testid="context-meter-slot"]'),
    ).not.toBeNull();

    // Centred as one group, not justified to the edges.
    expect(bar!.className).toContain('justify-center');
    expect(bar!.className).not.toContain('justify-between');

    // Tucked under the input: the form's bottom padding is the gap.
    const form = editor.closest('form')!;
    expect(form.className).toContain('pb-2');
    expect(form.className).not.toContain('pb-4');
  });

  it('feeds the round generating state to the bottom wave indicator', () => {
    useChatStore.setState({ isGenerating: true });
    const { container } = render(<ChatPanel />);

    const wave = container.querySelector('[data-testid="wave-loading"]');
    expect(wave).not.toBeNull();
    // The wave lives inside the chat column, under the message feed.
    const editor = container.querySelector('[data-testid="input-editor"]')!;
    const editorPanel = editor.closest('[data-slot="tabs-content"]')!;
    expect(editorPanel.contains(wave)).toBe(true);
  });

  it('offers an input-permitting placeholder while approvals are pending', () => {
    useChatStore.setState({
      events: [
        {
          time: 1,
          type: 'approval_asked',
          data: { callId: 'c1', name: 'bash', riskTier: 'WRITE_HIGH' },
        },
      ],
    });
    const { container } = render(<ChatPanel />);

    const editor = container.querySelector('[data-testid="input-editor"]');
    expect(editor).not.toBeNull();
    // The composer stays usable during approvals (scenario F), so the
    // placeholder must steer the user to keep typing — it must not imply
    // the composer is locked until the decision lands. The Placeholder
    // extension decorates the empty paragraph, not the editable root.
    const decorated = container.querySelector('[data-placeholder]');
    expect(decorated?.getAttribute('data-placeholder')).toBe(
      '审批等待中——可继续输入，将排队',
    );
    expect(editor!.getAttribute('contenteditable')).toBe('true');
  });
});
