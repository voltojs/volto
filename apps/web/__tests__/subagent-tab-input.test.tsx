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
    entries: [],
    status: 'done',
    isLoading: false,
    error: null,
    retry: () => {},
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
    useChatStore.setState({
      subagents: { c1: { events: [], deltas: [], status: 'done', durationMs: 10 } },
    });
    useConfigStore.setState({
      projects: [{ id: 'p1', path: '/tmp/p1', name: 'p1', createdAt: 0 }],
      providers: [PROVIDER],
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
    expect(editor.placeholder).toMatch(/父会话缺少项目或模型绑定/);
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
});
