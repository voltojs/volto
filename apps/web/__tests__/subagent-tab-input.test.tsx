/**
 * SubagentTab continued-chat input: the chat view gains a bottom InputBar
 * wired to `useSubagentChatAgent`, disabled while the child is running or
 * when the parent session lacks a project/model binding, and carrying
 * local-only model / effort / permission overrides per send.
 *
 * InputBar is mocked so assertions target SubagentTab's wiring (props +
 * sendMessage overrides) rather than tiptap keystroke plumbing — that path
 * is already covered by components/chat/__tests__/input-bar.test.tsx.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { SubagentTab } from '@/components/pane/SubagentTab';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore, type Session } from '@/stores/session-store';
import { useConfigStore, type Provider } from '@/stores/config-store';

const sendMessage = vi.hoisted(() => vi.fn(async () => {}));
const stopGeneration = vi.hoisted(() => vi.fn(async () => {}));
const useSubagentChatAgentMock = vi.hoisted(() => vi.fn());
const agentRuntime = vi.hoisted(() => ({ isGenerating: false }));
// Feed entries the mocked `useSubagentConversation` returns; cases push an
// assistant message carrying `turnUsage.source` to simulate a child that ran
// on a tier-resolved model.
const conversationRuntime = vi.hoisted(() => ({ entries: [] as unknown[] }));

vi.mock('@/hooks/use-subagent-chat-agent', () => ({
  useSubagentChatAgent: (options: unknown) => {
    useSubagentChatAgentMock(options);
    return {
      sendMessage,
      stopGeneration,
      isGenerating: agentRuntime.isGenerating,
    };
  },
}));

vi.mock('@/lib/sessions-api', () => ({
  fetchSessionEvents: vi.fn().mockResolvedValue({ sessionId: 'x', events: [] }),
}));

vi.mock('@/hooks/use-subagent-conversation', () => ({
  useSubagentConversation: () => ({
    entries: conversationRuntime.entries,
    status: 'done',
    isLoading: false,
    error: null,
    retry: () => {},
  }),
}));

vi.mock('@/hooks/use-subagent-context-usage', () => ({
  useSubagentContextUsage: () => ({
    projectedTokens: 1500,
    breakdown: { system: 100, tools: 0, messages: 1400 },
    layers: [],
    anchored: true,
  }),
}));

interface MockInputBarProps {
  onSubmit?: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  toolbar?: ReactNode;
  trailing?: ReactNode;
  isGenerating?: boolean;
  onStop?: () => void;
  projectId?: string | null;
}

vi.mock('@/components/chat/InputBar', () => ({
  InputBar: ({
    onSubmit,
    disabled,
    placeholder,
    toolbar,
    trailing,
    isGenerating,
    onStop,
  }: MockInputBarProps) => (
    <form
      data-testid="subagent-input-bar"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        const data = new FormData(event.currentTarget);
        const text = String(data.get('text') ?? '');
        if (text.length > 0) onSubmit?.(text);
      }}
    >
      <textarea
        name="text"
        data-testid="subagent-input-editor"
        placeholder={placeholder}
        disabled={disabled}
      />
      <div data-testid="subagent-input-toolbar">{toolbar}</div>
      <div data-testid="subagent-input-trailing">{trailing}</div>
      {isGenerating && onStop ? (
        <button type="button" onClick={onStop} aria-label="中断生成">
          中断生成
        </button>
      ) : (
        <button type="submit" disabled={disabled} aria-label="发送">
          发送
        </button>
      )}
    </form>
  ),
}));

// jsdom lacks pointer-capture APIs Base UI Select/Popover touch.
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
  models: [
    { id: 'm1', name: 'MiMo', code: 'mimo' },
    { id: 'm2', name: 'MiMo-Pro', code: 'mimo-pro' },
  ],
};

// The economy tier's target — a different provider than the parent session,
// exactly the q849t9jlu/6331cu2xz shape: the child ran here, the parent on
// MiMo, and the tab must show the child's model by default.
const QWEN_PROVIDER: Provider = {
  kind: 'custom',
  id: 'q1',
  name: 'Qwen Token Plan CN',
  baseURL: 'https://example.com/q1',
  apiKeyMasked: null,
  models: [{ id: 'qwen3.6-flash', name: 'Qwen3.6 Flash', code: 'qwen3.6-flash' }],
};

/** One projected assistant entry carrying the child turn's route source. */
function childAssistantEntry(source: { providerId?: string; modelId: string }) {
  return {
    kind: 'message',
    message: {
      id: 'child-a1',
      role: 'assistant',
      blocks: [],
      content: 'child done',
      timestamp: 1,
      turnUsage: {
        inputTokens: 13001,
        outputTokens: 867,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 13868,
        source,
        missingUsageCalls: 0,
      },
    },
  };
}

const PARENT_SESSION = {
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
  permissionMode: 'ask',
  reasoningEffort: 'high',
} as unknown as Session;

const chatTab = {
  kind: 'subagent',
  id: 'subagent:c1',
  childSessionId: 'c1',
  view: 'chat',
  parentSessionId: 's1',
} as const;

/** Legacy tab shape opened before parentSessionId existed. */
const legacyChatTab = {
  kind: 'subagent',
  id: 'subagent:c1',
  childSessionId: 'c1',
  view: 'chat',
} as const;

function seedParent(overrides: Partial<Session> = {}) {
  useSessionStore.setState({
    currentSessionId: 's1',
    sessions: [{ ...PARENT_SESSION, ...overrides }],
  });
}

describe('SubagentTab input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentRuntime.isGenerating = false;
    conversationRuntime.entries = [];
    useChatStore.setState({
      subagents: { c1: { events: [], deltas: [], status: 'done', durationMs: 10 } },
    });
    useConfigStore.setState({
      projects: [{ id: 'p1', path: '/tmp/p1', name: 'p1', createdAt: 0 }],
      providers: [PROVIDER, QWEN_PROVIDER],
      catalogProviders: [],
      loaded: true,
      error: null,
    });
    seedParent();
  });

  it('disables input while the child is running', () => {
    useChatStore.setState({
      subagents: { c1: { events: [], deltas: [], status: 'running' } },
    });
    render(<SubagentTab tab={chatTab} />);
    const editor = screen.getByTestId('subagent-input-editor') as HTMLTextAreaElement;
    expect(editor.disabled).toBe(true);
    expect(editor.placeholder).toMatch(/子代理执行中/);
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('disables input when the agent reports a continued turn in flight', () => {
    agentRuntime.isGenerating = true;
    render(<SubagentTab tab={chatTab} />);
    const editor = screen.getByTestId('subagent-input-editor') as HTMLTextAreaElement;
    expect(editor.disabled).toBe(true);
    // Stop stays available so the user can cancel the continued turn.
    expect(screen.getByRole('button', { name: '中断生成' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '中断生成' }));
    expect(stopGeneration).toHaveBeenCalled();
  });

  it('disables input when the parent session lacks a project or model binding', () => {
    seedParent({ projectId: null, modelId: null });
    render(<SubagentTab tab={chatTab} />);
    const editor = screen.getByTestId('subagent-input-editor') as HTMLTextAreaElement;
    expect(editor.disabled).toBe(true);
    expect(editor.placeholder).toMatch(/父会话.*缺少项目或模型绑定/);
  });

  it('binds config to tab.parentSessionId, not the current session', () => {
    // Current session is a different workspace; the tab must keep using the
    // parent that opened it.
    seedParent();
    useSessionStore.setState({
      currentSessionId: 's2',
      sessions: [
        { ...PARENT_SESSION },
        {
          ...PARENT_SESSION,
          id: 's2',
          projectId: 'p2',
          providerId: 'v2',
          modelId: 'm9',
          permissionMode: 'auto',
          reasoningEffort: 'low',
        },
      ],
    });
    render(<SubagentTab tab={chatTab} />);
    expect(useSubagentChatAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          projectId: 'p1',
          providerId: 'v1',
          modelId: 'm1',
          permissionMode: 'ask',
          reasoningEffort: 'high',
        }),
      }),
    );
    const editor = screen.getByTestId('subagent-input-editor') as HTMLTextAreaElement;
    expect(editor.disabled).toBe(false);
  });

  it('disables input when the bound parent session is gone from the store', () => {
    seedParent();
    useSessionStore.setState({ currentSessionId: 's2', sessions: [] });
    render(<SubagentTab tab={chatTab} />);
    const editor = screen.getByTestId('subagent-input-editor') as HTMLTextAreaElement;
    expect(editor.disabled).toBe(true);
    expect(editor.placeholder).toMatch(/父会话不可用/);
    expect(useSubagentChatAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          projectId: null,
          providerId: null,
          modelId: null,
        }),
      }),
    );
  });

  it('falls back to the current session for legacy tabs without parentSessionId', () => {
    seedParent();
    render(<SubagentTab tab={legacyChatTab} />);
    expect(useSubagentChatAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          projectId: 'p1',
          providerId: 'v1',
          modelId: 'm1',
        }),
      }),
    );
    const editor = screen.getByTestId('subagent-input-editor') as HTMLTextAreaElement;
    expect(editor.disabled).toBe(false);
  });

  it('passes the parent session binding into the subagent agent config', () => {
    render(<SubagentTab tab={chatTab} />);
    expect(useSubagentChatAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: 'c1',
        config: expect.objectContaining({
          projectId: 'p1',
          providerId: 'v1',
          modelId: 'm1',
          permissionMode: 'ask',
          reasoningEffort: 'high',
        }),
      }),
    );
  });

  it('sends through the subagent agent with parent-derived overrides when the child is done', () => {
    render(<SubagentTab tab={chatTab} />);
    const editor = screen.getByTestId('subagent-input-editor') as HTMLTextAreaElement;
    expect(editor.disabled).toBe(false);
    fireEvent.change(editor, { target: { value: 'follow up' } });
    fireEvent.submit(screen.getByTestId('subagent-input-bar'));
    expect(sendMessage).toHaveBeenCalledWith('follow up', {
      modelId: 'm1',
      providerId: 'v1',
      reasoningEffort: 'high',
      permissionMode: 'ask',
    });
  });

  it('applies local model and permission overrides on the next send', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<SubagentTab tab={chatTab} />);

    // Permission override via the real picker (Base UI Select needs real
    // pointer events — fireEvent.click does not commit the value).
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /自动/ }));

    // Model override via the real picker: open trigger → 模型 row → m2.
    await user.click(screen.getByRole('button', { name: /模型与推理等级/ }));
    await user.click(await screen.findByText('模型'));
    await user.click(await screen.findByText('MiMo-Pro'));

    const editor = screen.getByTestId('subagent-input-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'use the pro model' } });
    fireEvent.submit(screen.getByTestId('subagent-input-bar'));
    expect(sendMessage).toHaveBeenCalledWith('use the pro model', {
      modelId: 'm2',
      providerId: 'v1',
      // Effort override is cleared when the model changes; parent's 'high'
      // still fills the effective value.
      reasoningEffort: 'high',
      permissionMode: 'auto',
    });
  });

  it('renders the context meter beside the model picker', () => {
    render(<SubagentTab tab={chatTab} />);
    expect(screen.getByLabelText('上下文用量')).toBeDefined();
  });

  it('defaults the picker to the child tier-resolved model, not the parent binding', () => {
    // 6331cu2xz: the economy tier ran the child on Qwen3.6 Flash while the
    // parent stayed on MiMo. The usage card said Qwen; the picker must agree.
    conversationRuntime.entries = [
      childAssistantEntry({ providerId: 'q1', modelId: 'qwen3.6-flash' }),
    ];
    render(<SubagentTab tab={chatTab} />);
    expect(
      screen.getByRole('button', { name: /模型与推理等级/ }),
    ).toHaveTextContent('Qwen3.6 Flash');
  });

  it('continued turns stay on the child model unless overridden', () => {
    conversationRuntime.entries = [
      childAssistantEntry({ providerId: 'q1', modelId: 'qwen3.6-flash' }),
    ];
    render(<SubagentTab tab={chatTab} />);
    const editor = screen.getByTestId('subagent-input-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'more please' } });
    fireEvent.submit(screen.getByTestId('subagent-input-bar'));
    expect(sendMessage).toHaveBeenCalledWith('more please', {
      modelId: 'qwen3.6-flash',
      providerId: 'q1',
      reasoningEffort: 'high',
      permissionMode: 'ask',
    });
  });

  it('falls back to the parent binding when the child turn carries no usage', () => {
    // A child whose provider reports no usage leaves messages without
    // `turnUsage`: the picker stays on the parent's model — the pre-tier
    // behavior, unchanged.
    conversationRuntime.entries = [
      {
        kind: 'message',
        message: {
          id: 'child-a1',
          role: 'assistant',
          blocks: [],
          content: 'child done',
          timestamp: 1,
        },
      },
    ];
    render(<SubagentTab tab={chatTab} />);
    expect(
      screen.getByRole('button', { name: /模型与推理等级/ }),
    ).toHaveTextContent('MiMo');
  });
});
