/**
 * Regression gate for two defects seen in the running app:
 *  1. opening the right pane next to the conversation pushed the whole row
 *     wider than the window (a horizontal scrollbar appeared and the pane hung
 *     outside the layout);
 *  2. rendering the conversation + pane produced React "same key" warnings.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
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
    fetchSessionEvents: vi.fn().mockResolvedValue({ sessionId: 'x', events: [] }),
    fetchServerSessionDetail: vi.fn().mockResolvedValue({
      messages: [],
      contextUsage: null,
      projectId: 'p1',
      providerId: 'v1',
      modelId: 'm1',
      permissionMode: 'ask',
    }),
    renameServerSession: vi.fn().mockResolvedValue({}),
    fetchServerTrajectory: vi.fn().mockResolvedValue(null),
  };
});
vi.mock('@/lib/git-api', () => ({
  fetchGitSummary: vi.fn().mockResolvedValue({ isGit: true, branch: 'main', head: 'abc' }),
}));
vi.mock('@/lib/agent-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent-config')>();
  return {
    ...actual,
    createGatewaySSEClient: () => ({
      onStateChange: () => () => {},
      onEvent: vi.fn(),
      onDelta: vi.fn(),
      onError: vi.fn(),
      destroy: vi.fn(),
      setEventSourceFactory: vi.fn(),
      getConnectionToken: () => null,
      connect: () => {},
    }),
    postMessage: vi.fn(async () => {}),
    interruptTurn: vi.fn(async () => true),
  };
});

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

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
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
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('ChatPanel with the right pane open', () => {
  it('does not force the conversation column to full row width', () => {
    const { container } = render(<ChatPanel />);
    const tabs = container.querySelector('[data-slot="tabs"]');
    expect(tabs).not.toBeNull();
    const className = tabs!.getAttribute('class') ?? '';
    expect(className).toContain('min-w-0');
    expect(className).not.toContain('min-w-full');
  });

  it('renders without React duplicate-key warnings', () => {
    usePaneStore.setState({
      tabs: [
        { kind: 'files', id: 'files:p1', projectId: 'p1' },
        { kind: 'git-graph', id: 'git:p1', projectId: 'p1' },
      ],
      activeTabId: 'files:p1',
      open: true,
      hidden: false,
    });
    render(<ChatPanel />);

    const duplicateKeys = consoleError.mock.calls
      .map((args) => args.map(String).join(' '))
      .filter((message) => /same key|duplicate key|unique "key"/i.test(message));
    expect(duplicateKeys).toEqual([]);
  });
});
