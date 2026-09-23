/**
 * ChatPanel must hand the session's model capability down to the composer.
 *
 * InputBar has always known how to gate on `imageInput`, but nothing
 * passed it: the prop had no producer, so a model the gateway declares
 * text-only still offered an attachment button that could only fail. This
 * covers the wiring, not InputBar's own branch.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  };
});
vi.mock('@/lib/git-api', () => ({
  fetchGitSummary: vi.fn().mockResolvedValue({ isGit: false, branch: null, head: null }),
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

function providerWith(input?: ('text' | 'image')[]): Provider {
  return {
    kind: 'custom',
    id: 'v1',
    name: 'Gateway',
    baseURL: 'https://example.com/v1',
    apiKeyMasked: null,
    models: [
      {
        id: 'm1',
        name: 'Some model',
        code: 'some-model',
        ...(input === undefined ? {} : { input }),
      },
    ],
  };
}

function seedStores(provider: Provider): void {
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
    providers: [provider],
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
}

describe('ChatPanel vision gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides the attachment entry and explains why when the model declares no image input', () => {
    seedStores(providerWith(['text']));

    render(<ChatPanel />);

    expect(screen.queryByLabelText('添加图片')).toBeNull();
    expect(screen.getByText('当前模型不支持图片输入')).toBeTruthy();
  });

  it('keeps the attachment entry when image support is declared', () => {
    seedStores(providerWith(['text', 'image']));

    render(<ChatPanel />);

    expect(screen.queryByLabelText('添加图片')).not.toBeNull();
  });

  it('keeps the attachment entry when support is unknown', () => {
    // UNKNOWN is not `false` (spec §7): a gateway that cannot describe its
    // models must not lose the entry.
    seedStores(providerWith(undefined));

    render(<ChatPanel />);

    expect(screen.queryByLabelText('添加图片')).not.toBeNull();
  });
});
