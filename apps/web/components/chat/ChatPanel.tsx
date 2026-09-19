'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderPlus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { MessageList } from './MessageList';
import { InputBar } from './InputBar';
import { TodoDock } from './TodoDock';
import { ApprovalCard } from './ApprovalCard';
import { ChatHeader } from './ChatHeader';
import { ProjectPicker } from './ProjectPicker';
import { GitBranchPicker } from './GitBranchPicker';
import { ModelSettingsPicker } from './ModelSettingsPicker';
import { PermissionPicker } from './PermissionPicker';
import { ContextMeter } from './ContextMeter';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TrajectoryPanel } from '@/components/trajectory/TrajectoryPanel';
import { useChatStore } from '@/stores/chat-store';
import { usePaneStore } from '@/stores/pane-store';
import { RightPane } from '@/components/pane/RightPane';
import { useConversation } from '@/hooks/use-conversation';
import { useAutoOpenTasksTab } from '@/hooks/use-auto-open-tasks-tab';
import { useSessionStore, type PermissionMode } from '@/stores/session-store';
import { useConfigStore, providerModels } from '@/stores/config-store';
import { rememberEffort, rememberedEffort } from '@/lib/reasoning-preferences';
import { matchPlanCommand, type InputAction } from '@/lib/input-commands';
import { useChatAgent } from '@/hooks/use-chat-agent';
import { useAddProject } from '@/hooks/use-add-project';
import { ensureSessionDetail } from '@/hooks/use-server-sessions';
import { runSessionCompact } from '@/lib/session-compact';
import { postApproval } from '@/lib/agent-config';
import { selectPendingApprovals } from '@/lib/approvals';
import { foldTodosFromEvents } from '@/lib/todos-model';
import { cn } from '@/lib/utils';

export function ChatPanel() {
  const isGenerating = useChatStore((s) => s.isGenerating);
  const chatEvents = useChatStore((s) => s.events);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const { sendMessage, stopGeneration, connectionState, getApprovalToken } =
    useChatAgent();
  const { entries, usage, messages } = useConversation();
  // Rules of Hooks: must run before any early return below.
  useAutoOpenTasksTab();
  const projects = useConfigStore((s) => s.projects);
  const providers = useConfigStore((s) => s.providers);
  const pendingProjectId = useSessionStore((s) => s.pendingProjectId);
  const setPendingProjectId = useSessionStore((s) => s.setPendingProjectId);
  const { run: addProjectViaPicker, pending: addingProject } = useAddProject();

  // Model and permission choices for a session that doesn't exist yet.
  // Unlike `pendingProjectId`, nothing outside this component ever needs to
  // set these, so plain local state is enough — no store round-trip needed.
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(
    null,
  );
  const [pendingModelId, setPendingModelId] = useState<string | null>(null);
  const [pendingPermissionMode, setPendingPermissionMode] =
    useState<PermissionMode>('ask');
  // Cleared on every model change (below) rather than trying to mirror
  // `setSessionModel`'s keep-if-still-valid rule — there is no session yet
  // to carry that nuance for, so falling back to the new model's declared
  // default is enough.
  const [pendingReasoningEffort, setPendingReasoningEffort] = useState<
    string | undefined
  >(undefined);

  const hasModel = providers.some((p) => p.models.length > 0);

  // Defaults the welcome screen's project picker to the first workspace.
  // Only fills a genuinely empty selection — it never overrides a project
  // the user (or the sidebar's per-project "new conversation" button) has
  // already chosen, and projects can load asynchronously after mount.
  const firstProjectId = projects[0]?.id ?? null;
  useEffect(() => {
    if (pendingProjectId === null && firstProjectId) {
      setPendingProjectId(firstProjectId);
    }
  }, [pendingProjectId, firstProjectId, setPendingProjectId]);

  // Same default-to-first idea for model, but as a plain derived value rather
  // than an effect: `pendingProviderId`/`pendingModelId` are only ever both
  // null (no choice made yet) or both set together (by `ModelPicker`'s
  // `onChange` below), so falling back to the first provider's first model
  // while they're null cannot produce a mismatched provider/model pair.
  const firstProviderWithModels = providers.find((p) => p.models.length > 0);
  const effectiveProviderId =
    pendingProviderId ?? firstProviderWithModels?.id ?? null;
  const effectiveModelId =
    pendingModelId ??
    (firstProviderWithModels
      ? providerModels(firstProviderWithModels)[0]?.id
      : undefined) ??
    null;
  const pendingReasoning = useConfigStore((s) =>
    s.getModelReasoning(effectiveProviderId, effectiveModelId),
  );
  // A new session starts at the user's last choice for this exact model,
  // falling back to the model's own default. `rememberedEffort` validates
  // against the declared efforts, so a stale tier can never reach a turn.
  const effectiveReasoningEffort =
    pendingReasoningEffort ??
    rememberedEffort(
      effectiveProviderId,
      effectiveModelId,
      pendingReasoning?.efforts ?? [],
    ) ??
    pendingReasoning?.defaultEffort;

  // Fallback for entering a session by any path this component didn't itself
  // trigger the fetch for (e.g. a session already current on mount). Errors
  // are recorded on the session as a retryable `detailError` inside
  // ensureSessionDetail itself; the `.catch()` here only keeps a rejection
  // from becoming unhandled.
  useEffect(() => {
    if (currentSessionId) {
      void ensureSessionDetail(currentSessionId).catch(() => {});
    }
  }, [currentSessionId]);

  // 欢迎屏的草稿会话：首次 attach 图片时立即创建（纯内存记录，首次消息
  // 持久化前服务器毫不知情），让附件上传有会话可落。ref 持真值，state 只
  // 负责把 sessionId 传进 InputBar 触发 hook 的懒上传。
  const [draftSessionId, setDraftSessionId] = useState<string | null>(null);
  const draftSessionIdRef = useRef<string | null>(null);
  const ensureDraftSession = useCallback(() => {
    const existing = draftSessionIdRef.current;
    if (existing) return existing;
    const id = useSessionStore.getState().createSession({
      projectId: pendingProjectId,
      providerId: effectiveProviderId,
      modelId: effectiveModelId,
      permissionMode: pendingPermissionMode,
      reasoningEffort: effectiveReasoningEffort,
    });
    draftSessionIdRef.current = id;
    setDraftSessionId(id);
    return id;
  }, [
    pendingProjectId,
    effectiveProviderId,
    effectiveModelId,
    pendingPermissionMode,
    effectiveReasoningEffort,
  ]);

  const handleWelcomeSend = useCallback(
    (payload: { text: string; attachments: string[] }) => {
      const id = draftSessionIdRef.current ?? ensureDraftSession();
      // attach 之后用户可能改过工作区 / 模型 / 权限：发送前同步进草稿，
      // 避免拿着创建草稿时的旧绑定发出消息。
      if (effectiveProviderId && effectiveModelId) {
        useSessionStore
          .getState()
          .setSessionModel(id, effectiveProviderId, effectiveModelId);
      }
      useSessionStore.getState().setSessionPermissionMode(id, pendingPermissionMode);
      useSessionStore.getState().setSessionReasoningEffort(id, effectiveReasoningEffort);
      useSessionStore.getState().setCurrentSession(id);
      draftSessionIdRef.current = null;
      setDraftSessionId(null);
      void sendMessage(payload.text, payload.attachments);
    },
    [
      ensureDraftSession,
      effectiveProviderId,
      effectiveModelId,
      pendingPermissionMode,
      effectiveReasoningEffort,
      sendMessage,
    ],
  );

  // 用户 attach 后没发送就点开了别的会话：丢弃草稿（纯内存，从未持久化；
  // 若已上传过附件，孤儿目录由网关的 24h 回收机制清理）。
  useEffect(() => {
    if (currentSessionId === null) return;
    const draft = draftSessionIdRef.current;
    if (draft && draft !== currentSessionId) {
      draftSessionIdRef.current = null;
      setDraftSessionId(null);
      useSessionStore.getState().deleteSession(draft);
    }
  }, [currentSessionId]);

  // Once a session exists (the conversation branch below), sendMessage can
  // dispatch directly. The welcome screen sends through handleWelcomeSend:
  // text-only sends create the session on the spot (the old startSession
  // path), and sends carrying attachments reuse the draft session the first
  // attach already created, so the ready ids stay valid.
  const handleSubmit = (payload: { text: string; attachments: string[] }) =>
    void sendMessage(payload.text, payload.attachments);

  // Approvals still waiting on the user, derived from the buffered event
  // stream (see lib/approvals.ts) so a reconnect shows the same set as the
  // live stream did.
  //
  // Subscribe to the stable `events` reference and derive outside the
  // selector: `selectPendingApprovals` builds a fresh array every call, and
  // useSyncExternalStore (which zustand builds on) compares snapshots by
  // identity — returning a new array from the selector makes every snapshot
  // look changed, which React reports as "The result of getServerSnapshot
  // should be cached to avoid an infinite loop".
  const events = useChatStore((s) => s.events);
  const pendingApprovals = useMemo(
    () => selectPendingApprovals(events),
    [events],
  );

  // Subagent card click opens a RightPane tab via the pane-store command
  // entry. The callback identity stays stable — memo comparators depend on
  // it, and an inline arrow would rebuild every frame. parentSessionId is
  // stamped from the session that is current *now*, so a later session
  // switch cannot rebind this tab's continued-chat input to the wrong
  // workspace.
  const openSubagent = useCallback((childId: string) => {
    const parentSessionId = useSessionStore.getState().currentSessionId;
    usePaneStore
      .getState()
      .openTab({
        kind: 'subagent',
        id: `subagent:${childId}`,
        childSessionId: childId,
        view: 'chat',
        ...(parentSessionId !== null ? { parentSessionId } : {}),
      });
  }, []);

  // /clear 动作命令：与侧栏「新会话」完全同一行为（回欢迎屏 + 清聊天缓冲）。
  // /compact：与 Header「压缩上下文」按钮同一路径（toast 反馈，不改对话流）。
  // /plan：当前会话切到 plan 权限档（记住进入前档位），发送增强版计划提示
  // 词；welcome 屏还没有会话，不切模式，原文继续走既有发送路径。
  const handleInputAction = useCallback(
    (action: InputAction, rawText?: string) => {
      if (action === 'clear-session') {
        useSessionStore.getState().setCurrentSession(null);
        useChatStore.getState().clear();
        return;
      }
      if (action === 'compact-session') {
        const sessionId = useSessionStore.getState().currentSessionId;
        if (!sessionId) return;
        void runSessionCompact({
          sessionId,
          notify: {
            success: (message) => toast.success(message),
            error: (message) => toast.error(message),
          },
        });
        return;
      }
      if (action === 'enter-plan') {
        const goal = matchPlanCommand(rawText ?? '')?.goal ?? '';
        const store = useSessionStore.getState();
        const sid = store.currentSessionId;
        if (sid) {
          const current = store.sessions.find((s) => s.id === sid);
          // 已在 plan 态的重复 /plan 不重记进入前档位：否则 planPreviousMode
          // 会被 'plan' 覆盖，退出计划时无从恢复真正的原档位。
          if (current?.permissionMode !== 'plan') {
            store.setPlanPreviousMode(current?.permissionMode ?? 'ask');
          }
          store.setSessionPermissionMode(sid, 'plan');
          void sendMessage(
            '你已进入计划模式：工作区只读，唯一的写入口是 save_plan 工具（把计划写入 volto 存储）。\n' +
              '请按以下流程工作：\n' +
              '1. 调研相关代码与文档（read_file / glob / grep / bash 只读命令）；\n' +
              '2. 有不明确之处用 ask_user 向用户提问对齐（可给选项）；\n' +
              '3. 形成完整实施计划并用 save_plan 保存（分步任务、涉及文件、风险点）；\n' +
              '4. 保存后简短总结计划要点，等待用户批准。不要尝试修改工作区文件。\n' +
              (goal ? `目标：${goal}` : '目标：见上文用户描述'),
          );
        } else if (rawText) {
          // welcome 屏：没有会话可切，/plan 退回普通消息（服务器端按既有
          // 路径处理原文），与简报「welcome 回退」一致。
          handleWelcomeSend({ text: rawText, attachments: [] });
        }
        return;
      }
    },
    [sendMessage, handleWelcomeSend],
  );

  // Header 标题与右侧面板切换：依赖 currentSession/currentProject（下方
  // 声明），只在会话/项目解析后计算。

  const handleDecide = useCallback(
    async (
      callId: string,
      decision: 'allow' | 'deny',
      answer?: string[],
    ): Promise<void> => {
      if (!currentSessionId) return;
      try {
        await postApproval(
          currentSessionId,
          callId,
          decision,
          getApprovalToken(),
          // 仅 ask_user 卡片携带（选中 label 与自由输入的归并）；网关在
          // settle 前校验为 string[]。其余审批 undefined，请求体不带该字段。
          answer,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : '提交审批失败，请重试';
        useChatStore.getState().pushEvent({
          time: Date.now(),
          type: 'error',
          data: { message },
        });
      }
    },
    [currentSessionId, getApprovalToken],
  );

  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const currentProject = projects.find(
    (p) => p.id === currentSession?.projectId,
  );
  // Live SSE fold wins when the buffer has any todoListUpdated; otherwise
  // fall back to the seed from GET /sessions/:id so a cold reload restores
  // the dock without waiting for the next write.
  const liveTodos = useMemo(() => foldTodosFromEvents(chatEvents), [chatEvents]);
  const todos = liveTodos ?? currentSession?.todos ?? null;

  // Header 标题：会话标题（新会话尚未生成标题时回落项目名）→ 项目名 → 欢迎语。
  const headerTitle =
    currentSession?.title || currentProject?.name || '探索未至之境';

  // 右侧面板切换：可见时点击折叠（标签保留）；折叠时点击恢复；从未打开
  // 且无项目（总览开不了）时禁用。无 tab 时打开空面板（总览），不再直接
  // 开文件树。会话界面用会话绑定项目；欢迎界面用已选的 pending 项目，选
  // 中后即可查看文件 / Git 图谱。
  const paneTabs = usePaneStore((s) => s.tabs);
  const paneOpen = usePaneStore((s) => s.open);
  const paneHidden = usePaneStore((s) => s.hidden);
  const paneProjectId =
    currentProject?.id ?? (currentSessionId === null ? pendingProjectId : null);
  // Workspace switch: keep pane tab kinds (files / git-graph) but retarget
  // them at the new project so the right pane never shows a stale workspace.
  const retargetProjectTabs = usePaneStore((s) => s.retargetProjectTabs);
  useEffect(() => {
    if (paneProjectId === null) return;
    retargetProjectTabs(paneProjectId);
  }, [paneProjectId, retargetProjectTabs]);
  const hasPaneProject = paneProjectId !== null;
  const paneVisible =
    paneOpen && !paneHidden && (paneTabs.length > 0 || hasPaneProject);
  const paneToggle = useMemo(
    () => ({
      visible: paneVisible,
      disabled: !paneVisible && !paneOpen && !hasPaneProject,
      onToggle: () => {
        if (paneVisible) {
          usePaneStore.getState().setHidden(true);
        } else if (paneOpen) {
          usePaneStore.getState().setHidden(false);
        } else if (paneProjectId !== null) {
          usePaneStore.getState().openPane();
        }
      },
    }),
    [paneVisible, paneOpen, hasPaneProject, paneProjectId],
  );

  // Manual compact entry for the open session only. Idle-only enablement:
  // while a turn is generating the button is disabled (server would answer
  // 409 anyway); the toast path still covers a race where the turn starts
  // between click and response. Compaction never mutates the conversation
  // feed — see `runSessionCompact`.
  const compactAction = useMemo(
    () =>
      currentSessionId === null
        ? undefined
        : {
            disabled: isGenerating,
            onCompact: () => {
              void runSessionCompact({
                sessionId: currentSessionId,
                notify: {
                  success: (message) => toast.success(message),
                  error: (message) => toast.error(message),
                },
              });
            },
          },
    [currentSessionId, isGenerating],
  );

  // ContextMeter 的分母：当前会话绑定模型的上下文窗口；模型未配置窗口时
  // ContextMeter 自行渲染灰态。hook 必须在 welcome 屏的提前 return 之前调用。
  const currentModel = useConfigStore((s) =>
    s.findModel(
      currentSession?.providerId ?? null,
      currentSession?.modelId ?? null,
    ),
  );
  const currentReasoning = useConfigStore((s) =>
    s.getModelReasoning(
      currentSession?.providerId ?? null,
      currentSession?.modelId ?? null,
    ),
  );

  // 欢迎屏没有会话可读：按「当前选中的模型」（而非会话绑定模型）判定
  // vision 能力。同为 hook，必须在 welcome 分支的 early return 之前调用。
  const welcomeModel = useConfigStore((s) =>
    s.findModel(effectiveProviderId, effectiveModelId),
  );

  // Gates ContextMeter's "provider isn't reporting usage" hint: only true
  // once a full assistant round-trip has completed, so the hint cannot fire
  // mid-first-generation (see shouldShowUnanchoredHint).
  const hasCompletedAssistantMessage = messages.some(
    (m) => m.role === 'assistant' && !m.isStreaming,
  );

  // A session's project/provider/model binding can be null (e.g. the
  // project or model it referenced was later removed). use-chat-agent
  // guards against actually dispatching in that case, but the input should
  // also be disabled up front so the user sees why instead of typing into a
  // box that silently does nothing.
  const missingBinding =
    currentSessionId !== null &&
    (!currentSession?.projectId ||
      !currentSession.providerId ||
      !currentSession.modelId);

  // Only worth surfacing once a session exists — before that there is nothing
  // to connect to yet.
  const showOffline =
    currentSessionId !== null && connectionState !== 'connected';

  // 对话 / 轨迹两个视图的切换。本地 state：跨会话切换保留用户所在 tab，
  // 轨迹面板对新会话自行显示空态/加载态（spec §一）。
  const [activeTab, setActiveTab] = useState<'chat' | 'trajectory'>('chat');

  // A session whose detail hasn't been fetched yet has no messages in the
  // store either, which would otherwise be indistinguishable from a
  // genuinely empty conversation and flash the welcome screen. Render a
  // skeleton until ensureSessionDetail resolves, or a retryable error notice
  // if it failed — never a permanently silent skeleton.
  if (currentSessionId && currentSession && !currentSession.detailLoaded) {
    return (
      <div className="flex h-full flex-col">
        <ChatHeader
          title={headerTitle}
          paneToggle={paneToggle}
          compactAction={compactAction}
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          {currentSession.detailError ? (
            <>
              <p
                className={cn(
                  'text-sm',
                  currentSession.detailErrorKind === 'legacy'
                    ? 'text-muted-foreground'
                    : 'text-destructive',
                )}
              >
                {currentSession.detailError}
              </p>
              {/* A legacy-format transcript will 410 on every retry — offering
                  one would be worse than none, since it can never succeed. */}
              {currentSession.detailErrorKind !== 'legacy' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void ensureSessionDetail(currentSessionId).catch(() => {})
                  }
                >
                  重试
                </Button>
              )}
            </>
          ) : (
            <div className="text-muted-foreground text-sm">加载会话…</div>
          )}
        </div>
      </div>
    );
  }

  // Show welcome screen when there is nothing to render yet (an empty new
  // session, or no session selected at all).
  if (entries.length === 0) {
    return (
      <div className="flex h-full flex-col">
        {/* 欢迎页：选中工作区后 Header 面板按钮可用，右侧展示文件 / Git
            图谱总览；未选项目时禁用。 */}
        <ChatHeader
          title={headerTitle}
          paneToggle={paneToggle}
          compactAction={compactAction}
        />
        <div className="flex min-h-0 flex-1 flex-row">
          <div className="bg-grain flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center px-4">
            <div className="mb-8 max-w-2xl text-center">
              <div className="mb-5 flex items-center justify-center gap-3">
                <svg
                  viewBox="0 0 24 24"
                  className="text-primary h-9 w-9"
                  aria-hidden="true"
                >
                  <path
                    d="M4 5 L11 19 L13 19 L20 5 L17.2 5 L12 15.5 L6.8 5 Z"
                    fill="currentColor"
                  />
                </svg>
                <h2 className="font-display text-4xl font-semibold tracking-tight">
                  探索未至之境
                </h2>
              </div>
              <p className="text-muted-foreground">
                我是 Volto，你的 AI 助手。有什么我可以帮助你的吗？
              </p>
            </div>

            <div className="w-full max-w-2xl">
              {projects.length === 0 ? (
                <div className="flex flex-col items-center gap-3">
                  <p className="text-muted-foreground text-sm">
                    还没有工作区，添加一个开始吧
                  </p>
                  <Button
                    onClick={() =>
                      void addProjectViaPicker().then(
                        (p) => p && setPendingProjectId(p.id),
                      )
                    }
                    disabled={addingProject}
                    className="gap-2"
                  >
                    {addingProject ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <FolderPlus className="h-4 w-4" />
                    )}
                    {addingProject ? '正在等待系统对话框…' : '添加工作区'}
                  </Button>
                </div>
              ) : !hasModel ? (
                <p className="text-muted-foreground text-center text-sm">
                  请先在「设置」中添加供应商与模型
                </p>
              ) : (
                <>
                  <div className="mb-2 flex items-center gap-2 px-6">
                    <ProjectPicker
                      value={pendingProjectId}
                      onChange={setPendingProjectId}
                    />
                    {/* Workspace real HEAD, not session metadata — only shown
                        once a project is actually selected. */}
                    {pendingProjectId !== null && (
                      <GitBranchPicker projectId={pendingProjectId} />
                    )}
                  </div>
                  <InputBar
                    onSend={handleWelcomeSend}
                    sessionId={draftSessionId}
                    ensureSessionId={ensureDraftSession}
                    projectId={pendingProjectId}
                    // 欢迎屏还没有会话可读：按当前选中的模型判定 vision，
                    // 与会话内分支的 currentModel?.vision 三态语义一致。
                    visionSupported={welcomeModel?.vision}
                    onInputAction={handleInputAction}
                    disabled={
                      isGenerating ||
                      !pendingProjectId ||
                      pendingApprovals.length > 0
                    }
                    placeholder={
                      pendingApprovals.length > 0
                        ? '等待你的审批'
                        : pendingProjectId
                          ? '描述你想要构建的内容…'
                          : '请先选择工作区'
                    }
                    toolbar={
                      <PermissionPicker
                        value={pendingPermissionMode}
                        onChange={setPendingPermissionMode}
                      />
                    }
                    trailing={
                      <ModelSettingsPicker
                        providerId={effectiveProviderId}
                        modelId={effectiveModelId}
                        onModelChange={(providerId, modelId) => {
                          setPendingProviderId(providerId);
                          setPendingModelId(modelId);
                          setPendingReasoningEffort(undefined);
                        }}
                        efforts={pendingReasoning?.efforts ?? []}
                        effort={effectiveReasoningEffort}
                        onEffortChange={(effort) => {
                          rememberEffort(
                            effectiveProviderId,
                            effectiveModelId,
                            effort,
                          );
                          setPendingReasoningEffort(effort);
                        }}
                      />
                    }
                  />
                </>
              )}
            </div>
          </div>
          <RightPane projectId={pendingProjectId} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ChatHeader title={headerTitle} paneToggle={paneToggle} />
      {showOffline && (
        <div
          className={cn(
            'border-b px-4 py-1.5 text-center text-xs',
            connectionState === 'connecting'
              ? 'border-primary/20 bg-primary/10 text-primary'
              : 'border-destructive/20 bg-destructive/10 text-destructive',
          )}
        >
          {connectionState === 'connecting'
            ? '正在连接 agent 服务…'
            : '未连接 agent 服务，请确认 headless-server 已在 http://localhost:3100 启动'}
        </div>
      )}
      {/* Tabs (chat column: messages + TodoDock + input) + RightPane 同排。
          InputBar 仅住在 chat TabsContent，轨迹页不承载主输入框。 */}
      <div className="flex min-h-0 flex-1 flex-row">
        <Tabs
          value={activeTab}
          onValueChange={(value) =>
            setActiveTab(value as 'chat' | 'trajectory')
          }
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="mx-4 mt-2">
            <TabsTrigger value="chat">对话</TabsTrigger>
            <TabsTrigger value="trajectory">轨迹</TabsTrigger>
          </TabsList>
          <TabsContent
            value="chat"
            keepMounted
            className="flex min-h-0 flex-1 flex-row"
          >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <MessageList
                entries={entries}
                onOpenSubagent={openSubagent}
                sessionId={currentSessionId}
              />
              {pendingApprovals.length > 0 && (
                <div className="mx-auto w-full max-w-3xl space-y-2 px-6 pb-3">
                  {pendingApprovals.map((approval) => (
                    <ApprovalCard
                      key={approval.callId}
                      approval={approval}
                      onDecide={handleDecide}
                    />
                  ))}
                </div>
              )}
              {todos && todos.length > 0 && (
                <div className="mx-auto w-full max-w-3xl px-6">
                  <TodoDock todos={todos} />
                </div>
              )}
              <InputBar
                onSend={handleSubmit}
                sessionId={currentSessionId}
                projectId={currentProject?.id ?? null}
                // Three-state passthrough: undefined (the gateway never
                // declared) keeps the attachment entry; only an explicit
                // false disables it and says why.
                visionSupported={currentModel?.vision}
                onInputAction={handleInputAction}
                disabled={
                  isGenerating || missingBinding || pendingApprovals.length > 0
                }
                isGenerating={isGenerating}
                onStop={() => void stopGeneration()}
                placeholder={
                  pendingApprovals.length > 0
                    ? '等待你的审批'
                    : missingBinding
                      ? '此会话缺少绑定的项目或模型，无法发送消息'
                      : undefined
                }
                toolbar={
                  currentSessionId && currentSession ? (
                    <PermissionPicker
                      value={currentSession.permissionMode}
                      onChange={(mode) =>
                        useSessionStore
                          .getState()
                          .setSessionPermissionMode(currentSessionId, mode)
                      }
                    />
                  ) : null
                }
                trailing={
                  currentSessionId && currentSession ? (
                    <>
                      <ContextMeter
                        usage={usage}
                        contextWindow={currentModel?.contextWindow}
                        hasCompletedAssistantMessage={
                          hasCompletedAssistantMessage
                        }
                      />
                      <ModelSettingsPicker
                        providerId={currentSession.providerId}
                        modelId={currentSession.modelId}
                        onModelChange={(providerId, modelId) =>
                          useSessionStore
                            .getState()
                            .setSessionModel(
                              currentSessionId,
                              providerId,
                              modelId,
                            )
                        }
                        efforts={currentReasoning?.efforts ?? []}
                        effort={currentSession.reasoningEffort}
                        onEffortChange={(effort) =>
                          useSessionStore
                            .getState()
                            .setSessionReasoningEffort(
                              currentSessionId,
                              effort,
                            )
                        }
                      />
                    </>
                  ) : null
                }
              />
            </div>
          </TabsContent>
          <TabsContent
            value="trajectory"
            keepMounted
            className="flex min-h-0 flex-1 flex-col"
          >
            <TrajectoryPanel sessionId={currentSessionId} />
          </TabsContent>
        </Tabs>
        <RightPane projectId={currentProject?.id ?? null} />
      </div>
    </div>
  );
}
