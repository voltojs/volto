import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import type { TranscriptEventInput } from '@volto/sdk/sse';
import { InputBar, type InputBarProps } from '../InputBar';
import { ChatPanel } from '../ChatPanel';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { usePaneStore, PANE_WIDTH_DEFAULT } from '@/stores/pane-store';
import { useConfigStore, type Provider } from '@/stores/config-store';

// Transport doubles for the ChatPanel-gate cases below: the composer must
// actually reach `POST /messages` (steer routing) and `POST /interrupt`
// through the real use-chat-agent hook, so only the network layer is stubbed.
const transport = vi.hoisted(() => ({
  postMessage: vi.fn(async () => {}),
  interruptTurn: vi.fn(async () => true),
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
    postMessage: transport.postMessage,
    interruptTurn: transport.interruptTurn,
  };
});

vi.mock('@/lib/sessions-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sessions-api')>()),
  fetchSessionEvents: vi.fn().mockResolvedValue({ sessionId: 's1', events: [] }),
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
}));

vi.mock('@/lib/git-api', () => ({
  fetchGitSummary: vi
    .fn()
    .mockResolvedValue({ isGit: false, branch: null, head: null }),
}));

// jsdom 未实现 Range.getClientRects / Range.getBoundingClientRect（真实浏览器
// 都有）。tiptap 的 focus() 命令在 requestAnimationFrame 里才执行
// scrollIntoView（@tiptap/core focus.ts），该 rAF 回调经常晚于测试结束才触发，
// 此时 prosemirror coordsAtPos 的文本路径对 Range 调用上述 API → TypeError →
// vitest 记为 unhandled error（测试本身全绿，但进程退出码 1），全量跑偶发
// 击穿门禁（本文件的 Shift+Enter 用例同样走 focus 路径）。补齐空实现：
// singleRect 拿到空 rects 后走 getBoundingClientRect 兜底返回零矩形（jsdom
// 无布局，滚动为无害 no-op）。每个测试文件持有独立 jsdom 环境，顶层补丁不跨
// 文件泄漏（与文件级 ResizeObserver stub 同一模式）。
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  const emptyRectList: DOMRectList = Object.assign([] as DOMRect[], { item: () => null });
  Range.prototype.getClientRects = () => emptyRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}
// Same no-op stubs chat-panel-layout.test.tsx needs to mount ChatPanel.
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.setPointerCapture ??= () => {};

function setup(props: Partial<InputBarProps> = {}) {
  const onSubmit = vi.fn();
  const onInputAction = vi.fn();
  let editor: Editor | undefined;
  const utils = render(
    <InputBar
      onSubmit={onSubmit}
      onInputAction={onInputAction}
      onEditorReady={(e) => {
        editor = e;
      }}
      {...props}
    />,
  );
  const editorEl = () => utils.container.querySelector('[data-testid="input-editor"]')!;
  const sendButton = () => screen.getByRole('button', { name: '发送' });
  return { onSubmit, onInputAction, get editor() { return editor!; }, editorEl, sendButton, ...utils };
}

describe('InputBar（tiptap 底座）', () => {
  it('渲染 contenteditable 编辑器，空内容时发送按钮禁用', () => {
    const { editorEl, sendButton } = setup();
    expect(editorEl().getAttribute('contenteditable')).toBe('true');
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('输入文本 → 点击发送 → onSubmit(文本) + 编辑器清空', () => {
    const { editor, onSubmit, sendButton } = setup();
    act(() => void editor.commands.insertContent('你好'));
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(sendButton());
    expect(onSubmit).toHaveBeenCalledWith('你好');
    expect(editor.isEmpty).toBe(true);
  });

  it('Enter 提交、Shift+Enter 换行（单段落 + HardBreak）', () => {
    const { editor, onSubmit, editorEl } = setup();
    act(() => void editor.commands.insertContent('a'));
    fireEvent.keyDown(editorEl(), { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    act(() => void editor.commands.insertContent('b'));
    fireEvent.keyDown(editorEl(), { key: 'Enter', bubbles: true, cancelable: true });
    expect(onSubmit).toHaveBeenCalledWith('a\nb');
    expect(editor.getJSON().content?.length).toBe(1); // 永远单段落
  });

  it('IME 组合中的 Enter 不发送', () => {
    const { editor, onSubmit, editorEl } = setup();
    act(() => void editor.commands.insertContent('你好'));
    const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    editorEl().dispatchEvent(event);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(editor.isEmpty).toBe(false);
  });

  it('/clear 拦截：onInputAction 被调、onSubmit 不被调、编辑器清空', () => {
    const { editor, onSubmit, onInputAction, sendButton } = setup();
    act(() => void editor.commands.insertContent('/clear'));
    fireEvent.click(sendButton());
    expect(onInputAction).toHaveBeenCalledWith('clear-session');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(editor.isEmpty).toBe(true);
  });

  it('/compact 拦截：onInputAction 被调、onSubmit 不被调、编辑器清空', () => {
    const { editor, onSubmit, onInputAction, sendButton } = setup();
    act(() => void editor.commands.insertContent('/compact'));
    fireEvent.click(sendButton());
    expect(onInputAction).toHaveBeenCalledWith('compact-session');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(editor.isEmpty).toBe(true);
  });

  it('/clear now 不拦截（交服务端 Unknown command 兜底）', () => {
    const { editor, onSubmit, onInputAction, sendButton } = setup();
    act(() => void editor.commands.insertContent('/clear now'));
    fireEvent.click(sendButton());
    expect(onInputAction).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith('/clear now');
  });

  it('/plan 拦截：onInputAction("enter-plan", 原文) 被调、onSubmit 不被调', () => {
    const { editor, onSubmit, onInputAction, sendButton } = setup();
    act(() => void editor.commands.insertContent('/plan 重构登录'));
    fireEvent.click(sendButton());
    expect(onInputAction).toHaveBeenCalledWith('enter-plan', '/plan 重构登录');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(editor.isEmpty).toBe(true);
  });

  it('/plans 不拦截（前缀相同但命令名不同）', () => {
    const { editor, onSubmit, onInputAction, sendButton } = setup();
    act(() => void editor.commands.insertContent('/plans'));
    fireEvent.click(sendButton());
    expect(onInputAction).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith('/plans');
  });

  it('mention 节点序列化为 @路径 纯文本', () => {
    const { editor, onSubmit, sendButton } = setup();
    act(() =>
      void editor.commands.insertContent({
        type: 'mention',
        attrs: { id: 'src/a.ts', label: 'src/a.ts' },
      }),
    );
    fireEvent.click(sendButton());
    expect(onSubmit).toHaveBeenCalledWith('@src/a.ts');
  });

  it('mention + 文本混合序列化保留 @ 前缀', () => {
    const { editor, onSubmit, sendButton } = setup();
    act(() => {
      editor.commands.insertContent('看下 ');
      editor.commands.insertContent({ type: 'mention', attrs: { id: 'lib/x.ts', label: 'lib/x.ts' } });
      editor.commands.insertContent(' 这个文件');
    });
    fireEvent.click(sendButton());
    expect(onSubmit).toHaveBeenCalledWith('看下 @lib/x.ts 这个文件');
  });

  it('disabled 时编辑器不可编辑、发送禁用', () => {
    const { editorEl, sendButton } = setup({ disabled: true });
    expect(editorEl().getAttribute('contenteditable')).toBe('false');
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('富文本粘贴退化为纯文本（schema 无 mark 扩展，粗体等被丢弃）', () => {
    const { onSubmit, sendButton, editorEl } = setup();
    // 真实粘贴路径：clipboard 的 text/html 经 prosemirror-view 默认 handler
    // 走 schema 解析，无 mark 扩展时粗体被丢弃、文本保留。（不能用
    // insertContent(HTML 串) 作代理——无 mark schema 下解析结果是纯文本，
    // 会命中 tiptap insertContentAt 的 isOnlyTextContent 快速路径，把原始
    // 字符串当纯文本插入，schema 收敛被绕过。）
    fireEvent.paste(editorEl(), {
      clipboardData: { getData: () => '<strong>加粗</strong> 正文' },
    });
    fireEvent.click(sendButton());
    expect(onSubmit).toHaveBeenCalledWith('加粗 正文');
  });
});

// ── Task 13: the composer stays usable during generation / approvals ────────
// These cases render the full ChatPanel, not a bare InputBar: the `disabled`
// gate is computed by ChatPanel, so only the assembled panel can prove that
// the box is really editable and that Enter really reaches POST /messages.

const PROVIDER: Provider = {
  kind: 'custom',
  id: 'v1',
  name: 'Xiaomi',
  baseURL: 'https://example.com/v1',
  apiKeyMasked: null,
  models: [{ id: 'm1', name: 'MiMo', code: 'mimo' }],
};

function seedConversation() {
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
}

describe('InputBar gate during generation and approvals (ChatPanel)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedConversation();
  });

  it('InputBar is editable while isGenerating', async () => {
    useChatStore.setState({ isGenerating: true });
    render(<ChatPanel />);

    const editor = screen.getByTestId('input-editor');
    expect(editor.getAttribute('contenteditable')).toBe('true');

    fireEvent.paste(editor, { clipboardData: { getData: () => 'steer this turn' } });
    expect(editor).toHaveTextContent('steer this turn');

    fireEvent.keyDown(editor, { key: 'Enter', bubbles: true, cancelable: true });
    await waitFor(() =>
      expect(transport.postMessage).toHaveBeenCalledWith(
        's1',
        'steer this turn',
        expect.objectContaining({ projectId: 'p1', providerId: 'v1', modelId: 'm1' }),
        [],
      ),
    );
  });

  it('InputBar is editable while approvals are pending', async () => {
    useChatStore.setState({
      events: [
        {
          time: 1,
          type: 'approval_asked',
          data: { callId: 'call-1', name: 'bash', riskTier: 'WRITE_HIGH' },
        },
      ] as TranscriptEventInput[],
    });
    render(<ChatPanel />);

    // Sanity: the approval really is pending, so this case cannot go green
    // with the gate condition absent.
    expect(screen.getByText(/需要你的批准/)).toBeInTheDocument();

    const editor = screen.getByTestId('input-editor');
    expect(editor.getAttribute('contenteditable')).toBe('true');

    fireEvent.paste(editor, { clipboardData: { getData: () => 'steer during approval' } });
    expect(editor).toHaveTextContent('steer during approval');

    fireEvent.keyDown(editor, { key: 'Enter', bubbles: true, cancelable: true });
    await waitFor(() =>
      expect(transport.postMessage).toHaveBeenCalledWith(
        's1',
        'steer during approval',
        expect.objectContaining({ projectId: 'p1' }),
        [],
      ),
    );
  });

  it('stop button remains available while generating', async () => {
    useChatStore.setState({ isGenerating: true });
    render(<ChatPanel />);

    const stop = screen.getByRole('button', { name: '中断生成' });
    expect(stop).toBeEnabled();

    fireEvent.click(stop);
    await waitFor(() => expect(transport.interruptTurn).toHaveBeenCalledWith('s1'));
  });
});
