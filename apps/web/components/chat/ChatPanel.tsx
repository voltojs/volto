'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderPlus, Loader2 } from 'lucide-react';
import { MessageList } from './MessageList';
import { InputBar } from './InputBar';
import { ApprovalCard } from './ApprovalCard';
import { ChatHeader } from './ChatHeader';
import { ProjectPicker } from './ProjectPicker';
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
import { useSessionStore, type PermissionMode } from '@/stores/session-store';
import { useConfigStore, providerModels } from '@/stores/config-store';
import { rememberEffort, rememberedEffort } from '@/lib/reasoning-preferences';
import { useChatAgent } from '@/hooks/use-chat-agent';
import { useAddProject } from '@/hooks/use-add-project';
import { ensureSessionDetail } from '@/hooks/use-server-sessions';
import { postApproval } from '@/lib/agent-config';
import { selectPendingApprovals } from '@/lib/approvals';
import { cn } from '@/lib/utils';

export function ChatPanel() {
  const isGenerating = useChatStore((s) => s.isGenerating);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const { sendMessage, stopGeneration, connectionState, getApprovalToken } =
    useChatAgent();
  const { entries, usage, messages } = useConversation();
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

  const startSession = (content: string) => {
    const id = useSessionStore.getState().createSession({
      projectId: pendingProjectId,
      providerId: effectiveProviderId,
      modelId: effectiveModelId,
      permissionMode: pendingPermissionMode,
      reasoningEffort: effectiveReasoningEffort,
    });
    useSessionStore.getState().setCurrentSession(id);
    // No `ensureSessionDetail(id)` call here: `createSession` always sets
    // `detailLoaded: true` (a brand-new session's "detail" is just empty), so
    // it would be a guaranteed no-op — the effect above already covers any
    // session that needs a real fetch.
    void sendMessage(content);
  };

  // Once a session exists (the conversation branch below), sendMessage can
  // dispatch directly — the welcome screen is the only place that still needs
  // to create one first, via startSession.
  const handleSubmit = (content: string) => sendMessage(content);

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

  // 子代理卡片点击后经 pane-store 开 RightPane 标签；走
  // usePaneStore.getState() 的命令式入口并保持回调引用稳定——Task 11 的
  // memo 比较器依赖回调身份，内联箭头函数每帧新建会让 memo 失效。
  const openSubagent = useCallback((childId: string) => {
    usePaneStore
      .getState()
      .openTab({
        kind: 'subagent',
        id: `subagent:${childId}`,
        childSessionId: childId,
      });
  }, []);

  const handleDecide = useCallback(
    async (callId: string, decision: 'allow' | 'deny'): Promise<void> => {
      if (!currentSessionId) return;
      try {
        await postApproval(
          currentSessionId,
          callId,
          decision,
          getApprovalToken(),
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
        <ChatHeader />
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
        <ChatHeader
          onOpenFiles={
            currentProject
              ? () =>
                  usePaneStore.getState().openTab({
                    kind: 'files',
                    id: `files:${currentProject.id}`,
                    projectId: currentProject.id,
                  })
              : undefined
          }
          filesEnabled={currentProject !== undefined}
        />
        <div className="bg-grain flex flex-1 flex-col items-center justify-center px-4">
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
                <div className="mb-2 px-6">
                  <ProjectPicker
                    value={pendingProjectId}
                    onChange={setPendingProjectId}
                  />
                </div>
                <InputBar
                  onSubmit={startSession}
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
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ChatHeader
        projectName={currentProject?.name}
        connectionState={connectionState}
        onOpenFiles={
          currentProject
            ? () =>
                usePaneStore.getState().openTab({
                  kind: 'files',
                  id: `files:${currentProject.id}`,
                  projectId: currentProject.id,
                })
            : undefined
        }
        filesEnabled={currentProject !== undefined}
      />
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
      {/* 对话/轨迹主区 + RightPane 同排：pane 挂在 Tabs 外层，跨主 tab 切换常驻。 */}
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
              <MessageList entries={entries} onOpenSubagent={openSubagent} />
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
        <RightPane />
      </div>
      <InputBar
        onSubmit={handleSubmit}
        disabled={isGenerating || missingBinding || pendingApprovals.length > 0}
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
                hasCompletedAssistantMessage={hasCompletedAssistantMessage}
              />
              <ModelSettingsPicker
                providerId={currentSession.providerId}
                modelId={currentSession.modelId}
                onModelChange={(providerId, modelId) =>
                  useSessionStore
                    .getState()
                    .setSessionModel(currentSessionId, providerId, modelId)
                }
                efforts={currentReasoning?.efforts ?? []}
                effort={currentSession.reasoningEffort}
                onEffortChange={(effort) =>
                  useSessionStore
                    .getState()
                    .setSessionReasoningEffort(currentSessionId, effort)
                }
              />
            </>
          ) : null
        }
      />
    </div>
  );
}
