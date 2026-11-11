/**
 * The sub-agent pane must describe the CHILD's permission, not the parent
 * session's (spec 2026-11-11 G2/D7). The dispatch carries the effective
 * boundary on its `subagent_started` bracket; the pane reads it from the chat
 * store's bucket. Old sessions without the field fall back to the parent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SubagentTab } from '@/components/pane/SubagentTab';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore, type Session } from '@/stores/session-store';
import { useConfigStore, type Provider } from '@/stores/config-store';

vi.mock('@/hooks/use-subagent-chat-agent', () => ({
  useSubagentChatAgent: () => ({
    sendMessage: vi.fn(),
    stopGeneration: vi.fn(),
    isGenerating: false,
  }),
}));

vi.mock('@/lib/sessions-api', () => ({
  fetchSessionEvents: vi.fn().mockResolvedValue({ sessionId: 'x', events: [] }),
}));

let conversationMeta: { permissionMode?: string } | undefined;
vi.mock('@/hooks/use-subagent-conversation', () => ({
  useSubagentConversation: () => ({
    entries: [],
    status: 'done',
    isLoading: false,
    error: null,
    retry: () => {},
    meta: conversationMeta,
  }),
}));

vi.mock('@/hooks/use-subagent-context-usage', () => ({
  useSubagentContextUsage: () => ({
    projectedTokens: 0,
    breakdown: { system: 0, tools: 0, messages: 0 },
    layers: [],
    anchored: false,
  }),
}));

vi.mock('@/components/chat/InputBar', () => ({
  // The permission picker rides `toolbar`; the model picker rides `trailing`.
  InputBar: ({ toolbar, trailing }: { toolbar?: ReactNode; trailing?: ReactNode }) => (
    <div data-testid="subagent-input-bar">
      {toolbar}
      {trailing}
    </div>
  ),
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const PROVIDER: Provider = {
  kind: 'custom',
  id: 'v1',
  name: 'Xiaomi',
  baseURL: 'https://example.com/v1',
  apiKeyMasked: null,
  models: [{ id: 'm1', name: 'MiMo', code: 'mimo' }],
};

const PARENT = {
  id: 's1',
  title: 'parent',
  messages: [],
  messageCount: 0,
  detailLoaded: true,
  createdAt: 0,
  updatedAt: 0,
  projectId: 'p1',
  providerId: 'v1',
  modelId: 'm1',
  permissionMode: 'full',
  reasoningEffort: 'high',
} as unknown as Session;

const chatTab = {
  kind: 'subagent',
  id: 'subagent:c1',
  childSessionId: 'c1',
  view: 'chat',
  parentSessionId: 's1',
} as const;

function seedBucket(permission?: { sandbox: string; approval: string; preset?: string }) {
  useChatStore.setState({
    subagents: {
      c1: { events: [], deltas: [], status: 'done', durationMs: 10, ...(permission ? { permission } : {}) },
    },
  });
}

describe('SubagentTab permission display', () => {
  beforeEach(() => {
    conversationMeta = undefined;
    useSessionStore.setState({ currentSessionId: 's1', sessions: [{ ...PARENT }] });
    useConfigStore.setState({
      projects: [{ id: 'p1', path: '/tmp/p1', name: 'p1', createdAt: 0 }],
      providers: [PROVIDER],
      catalogProviders: [],
      loaded: true,
      error: null,
    });
  });

  it("shows the child's own preset, not the parent session's", () => {
    seedBucket({ sandbox: 'read-only', approval: 'never', preset: 'read-only' });
    render(<SubagentTab tab={chatTab} />);

    // The parent is `full`; the child ran read-only. Both the badge and the
    // picker must say 只读 — the badge is what the user reads without opening
    // any menu, so it gets its own assertion.
    const badge = screen.getByTestId('subagent-permission-badge');
    expect(badge).toHaveTextContent('只读');
    // The badge is the only place that explains what it constrains; a bare
    // "只读" invites reading it as an OS sandbox promise.
    expect(badge).toHaveAttribute('title', expect.stringContaining('工具权限'));
    expect(screen.queryByTestId('subagent-permission-badge')).toHaveTextContent(/^(?!完全)/);
    expect(screen.queryByText('完全')).not.toBeInTheDocument();
  });

  it("shows the child's preset after a reload, when only its session_meta survives", () => {
    // A settled session replays no events, so the bucket is gone after F5 —
    // the child's own meta is what the pane has left (reported regression).
    seedBucket();
    conversationMeta = { permissionMode: 'read-only' };
    render(<SubagentTab tab={chatTab} />);

    expect(screen.getByTestId('subagent-permission-badge')).toHaveTextContent('只读');
    expect(screen.queryByText('完全')).not.toBeInTheDocument();
  });

  it('falls back to the parent session when the bucket predates the field', () => {
    seedBucket();
    render(<SubagentTab tab={chatTab} />);

    expect(screen.getAllByText('完全').length).toBeGreaterThan(0);
    // No badge: the bucket has nothing to say, so the pane must not invent one.
    expect(screen.queryByTestId('subagent-permission-badge')).not.toBeInTheDocument();
  });
});