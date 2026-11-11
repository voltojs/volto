/**
 * ChatPanel 的两个 plan effect（final-review I-3）：
 *
 *  (a) turn-end 且 plan 态 → 拉取计划文档 → 打开 plan 标签（404/非 plan 态不动面板）；
 *  (b) 「按计划执行」派发 → setSessionPermissionMode(sid, planPreviousMode ?? 'ask')
 *      + sends the approval message.
 *
 * 取舍（最小侵入）：不 mock 整个组件树、也不把 effect 抽成纯函数——直接渲染
 * ChatPanel 本体，只 mock 掉网络型 hooks（use-chat-agent / use-conversation /
 * use-server-sessions / use-add-project）与 fetchPlan，RightPane 换成暴露
 * onExecutePlan 的桩（派发逻辑在 ChatPanel，不在 pane）。渲染走最轻分支：
 * turn-end effect 在 early-return 的骨架分支同样执行（hooks 先于 return），
 * 派发用 welcome 分支（entries 为空）——两条分支都避开了 tiptap / Markdown
 * 等纯展示子树。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChatPanel } from '../ChatPanel';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { usePaneStore } from '@/stores/pane-store';
import { useConfigStore } from '@/stores/config-store';
import type { TranscriptEventInput } from '@volto/sdk/sse';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  fetchPlan: vi.fn(),
  // RightPane 桩点击时上抛的 sessionId（= 被种子的当前会话）。
  executeTarget: 'session-1',
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
  // The plan-behaviour tests never store a queued entry; a plain false keeps
  // the entry effect on its normal, unforced path.
  needsQueueResync: vi.fn(() => false),
}));

vi.mock('@/lib/sessions-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPlan: mocks.fetchPlan,
  // The bottom status bar folds trajectory rows; keep tests offline.
  fetchServerTrajectory: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/components/pane/RightPane', () => ({
  RightPane: ({ onExecutePlan }: { onExecutePlan?: (sessionId: string) => void }) => (
    <button
      type="button"
      data-testid="stub-execute-plan"
      onClick={() => onExecutePlan?.(mocks.executeTarget)}
    >
      stub-execute
    </button>
  ),
}));

function seedSession(permissionMode: 'plan' | 'ask', detailLoaded: boolean) {
  useSessionStore.setState({
    currentSessionId: 'session-1',
    planPreviousMode: null,
    sessions: [
      {
        id: 'session-1',
        title: 't',
        messages: [],
        messageCount: 0,
        detailLoaded,
        createdAt: 0,
        updatedAt: 0,
        projectId: null,
        providerId: null,
        modelId: null,
        permissionMode,
      },
    ],
  });
}

function seedTurnEnd() {
  const event: TranscriptEventInput = {
    time: 1,
    type: 'turn_end',
    data: { turn: 1, reason: 'done' },
  };
  useChatStore.setState({ events: [event], deltas: [] });
}

describe('ChatPanel — plan 态 turn-end 拉取计划并打开标签', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({
      sessions: [],
      currentSessionId: null,
      planPreviousMode: null,
    });
    useChatStore.getState().clear();
    usePaneStore.setState({ tabs: [], activeTabId: null, open: false, hidden: false, snapshots: {}, activeSessionKey: null });
    useConfigStore.setState({ projects: [], providers: [] });
  });

  it('plan 态 + turn_end → fetchPlan 被调，计划存在则打开 plan 标签', async () => {
    seedSession('plan', false);
    seedTurnEnd();
    mocks.fetchPlan.mockResolvedValue({ content: '# 计划\n', updatedAt: 123 });

    render(<ChatPanel />);

    await waitFor(() => {
      expect(mocks.fetchPlan).toHaveBeenCalledWith('session-1');
    });
    await waitFor(() => {
      const pane = usePaneStore.getState();
      expect(pane.tabs).toContainEqual({
        kind: 'plan',
        id: 'session-1',
        sessionId: 'session-1',
      });
      expect(pane.open).toBe(true);
    });
  });

  it('plan 态但本轮无计划（404 → null）→ 不开标签', async () => {
    seedSession('plan', false);
    seedTurnEnd();
    mocks.fetchPlan.mockResolvedValue(null);

    render(<ChatPanel />);

    await waitFor(() => {
      expect(mocks.fetchPlan).toHaveBeenCalledWith('session-1');
    });
    expect(usePaneStore.getState().tabs).toEqual([]);
  });

  it('非 plan 态 → turn 结束不触发计划拉取', async () => {
    seedSession('ask', false);
    seedTurnEnd();

    render(<ChatPanel />);

    // 让 effect 与微任务都有机会跑完。
    await waitFor(() => {
      expect(useSessionStore.getState().currentSessionId).toBe('session-1');
    });
    expect(mocks.fetchPlan).not.toHaveBeenCalled();
    expect(usePaneStore.getState().tabs).toEqual([]);
  });
});

describe('ChatPanel — 「按计划执行」派发', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeTarget = 'session-1';
    useSessionStore.setState({
      sessions: [],
      currentSessionId: null,
      planPreviousMode: null,
    });
    useChatStore.getState().clear();
    usePaneStore.setState({ tabs: [], activeTabId: null, open: false, hidden: false, snapshots: {}, activeSessionKey: null });
    useConfigStore.setState({ projects: [], providers: [] });
  });

  it('内存无 planPreviousMode（刷新丢失）→ 回退 ask 并发送执行消息', () => {
    seedSession('plan', true);

    render(<ChatPanel />);
    fireEvent.click(screen.getByTestId('stub-execute-plan'));

    expect(mocks.sendMessage).toHaveBeenCalledWith('The plan is approved — start executing it.');
    const mode = useSessionStore
      .getState()
      .sessions.find((s) => s.id === 'session-1')?.permissionMode;
    expect(mode).toBe('ask');
  });

  it('记住了进入前档位 → 恢复该档位而非写死值', () => {
    seedSession('plan', true);
    useSessionStore.setState({ planPreviousMode: 'auto' });

    render(<ChatPanel />);
    fireEvent.click(screen.getByTestId('stub-execute-plan'));

    expect(mocks.sendMessage).toHaveBeenCalledWith('The plan is approved — start executing it.');
    const mode = useSessionStore
      .getState()
      .sessions.find((s) => s.id === 'session-1')?.permissionMode;
    expect(mode).toBe('auto');
  });
});

// welcome 屏的 /plan（用户实测踩坑）：无活动会话时不能把 "/plan" 原文发给
// 服务器（/plan 模板已移除 → "Unknown command"）——应当以 plan 档创建会话
// 并发送计划提示。
vi.mock('@/components/chat/InputBar', () => ({
  InputBar: (props: { onInputAction?: (action: string, rawText?: string) => void }) => (
    <button
      type="button"
      data-testid="stub-enter-plan"
      onClick={() => props.onInputAction?.('enter-plan', '/plan 重构登录')}
    >
      stub-input
    </button>
  ),
}));

describe('ChatPanel — welcome 屏的 /plan', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );
    mocks.sendMessage.mockClear();
    useSessionStore.setState({
      currentSessionId: null,
      planPreviousMode: null,
      pendingProjectId: 'proj-1',
      sessions: [],
    });
    useConfigStore.setState({
      projects: [{ id: 'proj-1', name: 'P', path: '/tmp/p', createdAt: 0 }],
      providers: [
        { id: 'prov-1', name: 'P', models: [{ id: 'm1', code: 'model-1' }] },
      ] as never,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('以 plan 档创建会话并发送计划提示，而不是把 /plan 原文发出去', async () => {
    render(<ChatPanel />);
    fireEvent.click(screen.getByTestId('stub-enter-plan'));
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalled());

    // 只发送用户输入的目标（流程说明经服务端 system 层注入，不占用户消息）。
    const sent = mocks.sendMessage.mock.calls[0]?.[0] as string;
    expect(sent).toBe('重构登录');

    const store = useSessionStore.getState();
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0]?.permissionMode).toBe('plan');
    expect(store.currentSessionId).toBe(store.sessions[0]?.id);
    // welcome 没有进入前档位：planPreviousMode 保持 null（执行回退 ask）。
    expect(store.planPreviousMode).toBeNull();
  });
});

// 会话内 /plan：切 plan 档 + 只发用户目标文本（流程说明走 system 层）。
describe('ChatPanel — 会话内 /plan', () => {
  beforeEach(() => {
    mocks.sendMessage.mockClear();
    useSessionStore.setState({
      currentSessionId: 'session-1',
      planPreviousMode: null,
      sessions: [
        {
          id: 'session-1',
          title: 't',
          messages: [],
          messageCount: 0,
          detailLoaded: true,
          createdAt: 1,
          updatedAt: 1,
          projectId: 'proj-1',
          providerId: 'prov-1',
          modelId: 'm1',
          permissionMode: 'ask',
        },
      ],
    } as never);
  });

  it('切换 plan 档且只发送目标文本', async () => {
    render(<ChatPanel />);
    fireEvent.click(screen.getByTestId('stub-enter-plan'));
    await waitFor(() =>
      expect(
        useSessionStore.getState().sessions.find((s) => s.id === 'session-1')?.permissionMode,
      ).toBe('plan'),
    );
    expect(mocks.sendMessage).toHaveBeenCalledWith('重构登录');
    expect(mocks.sendMessage).not.toHaveBeenCalledWith(expect.stringContaining('save_plan'));
  });
});
