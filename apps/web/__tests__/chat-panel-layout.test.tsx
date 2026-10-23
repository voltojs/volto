/**
 * ChatPanel layout contract: the conversation-mode InputBar lives inside the
 * chat TabsContent column (with MessageList / ApprovalCards), not as a page
 * footer sibling of the row that holds Tabs + RightPane. Trajectory tab must
 * not host the main input.
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

    // Same column as MessageList: the chat panel's first flex-col child.
    const chatColumn = editorPanel!.querySelector(
      '.flex.min-h-0.min-w-0.flex-1.flex-col',
    );
    expect(chatColumn).not.toBeNull();
    expect(chatColumn!.contains(editor!)).toBe(true);
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
});
