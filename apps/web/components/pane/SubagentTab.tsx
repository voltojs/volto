'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useChatStore } from '@/stores/chat-store';
import {
  useSessionStore,
  type PermissionMode,
} from '@/stores/session-store';
import { useConfigStore } from '@/stores/config-store';
import { usePaneStore } from '@/stores/pane-store';
import { useTrajectoryDrawerStore } from '@/stores/trajectory-drawer-store';
import { useFileRefs } from '@/hooks/use-file-refs';
import { useSubagentConversation } from '@/hooks/use-subagent-conversation';
import { useSubagentChatAgent } from '@/hooks/use-subagent-chat-agent';
import { useSubagentContextUsage } from '@/hooks/use-subagent-context-usage';
import { useStoredRows } from '@/hooks/use-trajectory';
import { formatDuration } from '@/lib/trajectory-view-model';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MessageList } from '@/components/chat/MessageList';
import { ConversationColumn } from '@/components/chat/ConversationColumn';
import { useStreamDensity } from '@/lib/stream-density';
import { InputBar } from '@/components/chat/InputBar';
import { ContextMeter } from '@/components/chat/ContextMeter';
import { ModelSettingsPicker } from '@/components/chat/ModelSettingsPicker';
import { PermissionPicker } from '@/components/chat/PermissionPicker';
import { TrajectoryList } from '@/components/trajectory/TrajectoryList';
import type { PaneTab } from '@/stores/pane-store';

/**
 * RightPane 的子代理标签体：对话 / 轨迹两个子视图，受控于标签载荷的
 * `view` 字段（卡片点击开对话，「查看执行过程」开轨迹——openTab 同 id
 * 覆盖载荷，本组件不持视图状态）。对话视图原样平移旧版独立执行分栏的
 * 行为矩阵（加载 → 错误+重试 → 运行中桶 → entries 空判无记录 → 列表）
 * 并 keepMounted 保滚动；轨迹视图是盘上快照（useStoredRows 缓存）。
 * 对话视图底部是继续对话输入框：配置继承标签载入时的父会话
 * （`parentSessionId`），模型 / 推理等级 / 权限覆盖只活在本组件 state
 * （标签 remount 即重置）。
 * 关闭职责归 RightPane 标签栏，本组件不渲染关闭按钮。
 */
export function SubagentTab({ tab }: { tab: PaneTab }) {
  const t = useTranslations('pane');
  // hooks 无条件调用（rules-of-hooks）：kind 窄化走三元派生，非本类标签
  // 在渲染处返回 null。tab.kind 对同一挂载实例恒定（换 kind 即换组件类型
  // → remount），钩子顺序稳定。
  const childId = tab.kind === 'subagent' ? tab.childSessionId : undefined;
  const parentSessionId =
    tab.kind === 'subagent' ? tab.parentSessionId : undefined;
  const bucket = useChatStore((s) =>
    childId !== undefined ? s.subagents[childId] : undefined,
  );
  const feed = useSubagentConversation(childId ?? null);
  // Same display preference as the main chat: a sub-agent's execution detail
  // is read at the same distance, so it must not have a second setting.
  const [streamDensity] = useStreamDensity();
  // Parent config is bound to the session that spawned this tab, not the
  // session that happens to be current. Legacy tabs without parentSessionId
  // fall back to currentSessionId; a parent that has left the store yields
  // undefined and disables the input (see `missing` below).
  const parent = useSessionStore((s) =>
    s.sessions.find((x) => x.id === (parentSessionId ?? s.currentSessionId)),
  );

  // Local-only config overrides for continued turns. Reset when the tab
  // remounts — nothing outside this mount needs to see them.
  const [overrideModel, setOverrideModel] = useState<{
    providerId: string;
    modelId: string;
  } | null>(null);
  const [overrideEffort, setOverrideEffort] = useState<string | undefined>(
    undefined,
  );
  const [overridePermission, setOverridePermission] = useState<
    PermissionMode | undefined
  >(undefined);

  // Effective model for the pickers + efforts list: override wins, parent
  // fills in. Effort ids are model-scoped, so efforts follow the effective
  // model rather than the parent's frozen one.
  const effectiveProviderId =
    overrideModel?.providerId ?? parent?.providerId ?? null;
  const effectiveModelId = overrideModel?.modelId ?? parent?.modelId ?? null;
  const reasoning = useConfigStore((s) =>
    s.getModelReasoning(effectiveProviderId, effectiveModelId),
  );
  // ContextMeter denominator: the effective model's window (override wins).
  // findModel is already used elsewhere for this; null model → meter gray.
  const effectiveModel = useConfigStore((s) =>
    s.findModel(effectiveProviderId, effectiveModelId),
  );

  const usage = useSubagentContextUsage(childId ?? null);

  const agent = useSubagentChatAgent({
    childSessionId: childId ?? null,
    // Base config is the parent session's binding; per-send overrides layer
    // on top inside sendMessage.
    config: {
      projectId: parent?.projectId ?? null,
      providerId: parent?.providerId ?? null,
      modelId: parent?.modelId ?? null,
      reasoningEffort: parent?.reasoningEffort,
      permissionMode: parent?.permissionMode,
    },
  });

  // Sub-agent prose refs resolve under the child session's own annotations.
  useFileRefs(parent?.projectId ?? null, childId ?? null);

  if (tab.kind !== 'subagent') return null;
  // 闭包窄化：TS 不把判别联合的窄化带进回调，先提取本类标签引用再展开。
  const subTab = tab;

  const running = bucket?.status === 'running' || agent.isGenerating;
  const missing = !parent?.projectId || !parent?.providerId || !parent?.modelId;
  const hasCompletedAssistantMessage = feed.entries.some(
    (e) =>
      e.kind === 'message' &&
      e.message.role === 'assistant' &&
      e.message.isStreaming !== true,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
        <span className="text-foreground/90 font-mono">task</span>
        <span className="text-muted-foreground">
          {bucket?.status === 'running' && t('subagent.running')}
          {bucket?.status === 'done' &&
            (bucket.durationMs !== undefined
              ? t('subagent.doneDuration', { duration: formatDuration(bucket.durationMs) ?? '' })
              : t('subagent.done'))}
          {bucket?.status === 'error' && <span className="text-destructive">{t('subagent.failed')}</span>}
        </span>
        <span className="text-muted-foreground/60 min-w-0 flex-1 truncate font-mono text-[10px]">
          {childId}
        </span>
      </div>
      <Tabs
        value={subTab.view}
        onValueChange={(value) =>
          usePaneStore
            .getState()
            .openTab({ ...subTab, view: value as 'chat' | 'trajectory' })
        }
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="mx-3 mt-2">
          <TabsTrigger value="chat">{t('subagent.chat')}</TabsTrigger>
          <TabsTrigger value="trajectory">{t('subagent.trajectory')}</TabsTrigger>
        </TabsList>
        {/* 对话：keepMounted 保滚动；行为矩阵逐行平移自旧版独立执行分栏。 */}
        <TabsContent value="chat" keepMounted className="flex min-h-0 flex-1 flex-col">
          <ConversationColumn>
            {feed.isLoading ? (
              <div className="text-muted-foreground p-4 text-sm">{t('subagent.loading')}</div>
            ) : feed.error !== null ? (
              <div className="flex flex-col items-start gap-3 p-4">
                <p className="text-destructive text-sm">{feed.error}</p>
                <Button variant="outline" size="sm" onClick={feed.retry}>
                  {t('subagent.retry')}
                </Button>
              </div>
            ) : bucket?.status === 'running' ? (
              <MessageList
                entries={feed.entries}
                sessionId={childId}
                fileProjectId={parent?.projectId ?? null}
                isGenerating={running}
                density={streamDensity}
              />
            ) : feed.entries.length === 0 ? (
              <div className="text-muted-foreground p-4 text-sm">{t('subagent.empty')}</div>
            ) : (
              <MessageList
                entries={feed.entries}
                sessionId={childId}
                fileProjectId={parent?.projectId ?? null}
                isGenerating={running}
                density={streamDensity}
              />
            )}
          {/* Continued-chat input: disabled while the original turn runs, while
              a continued turn streams, or when the bound parent session is
              missing from the store / lacks a project-model binding. */}
          <InputBar
            onSubmit={(text) =>
              void agent.sendMessage(text, {
                modelId: overrideModel?.modelId ?? parent?.modelId,
                // Provider must follow a model override.
                providerId: overrideModel?.providerId ?? parent?.providerId,
                reasoningEffort: overrideEffort ?? parent?.reasoningEffort,
                permissionMode: overridePermission ?? parent?.permissionMode,
              })
            }
            disabled={running || missing}
            isGenerating={agent.isGenerating}
            onStop={() => void agent.stopGeneration()}
            projectId={parent?.projectId ?? null}
            placeholder={
              running
                ? t('subagent.runningHint')
                : missing
                  ? t('subagent.missingHint')
                  : undefined
            }
            toolbar={
              <PermissionPicker
                value={overridePermission ?? parent?.permissionMode ?? 'ask'}
                onChange={setOverridePermission}
              />
            }
            trailing={
              <>
                <ContextMeter
                  usage={usage}
                  contextWindow={effectiveModel?.contextWindow}
                  hasCompletedAssistantMessage={hasCompletedAssistantMessage}
                />
                <ModelSettingsPicker
                  providerId={effectiveProviderId}
                  modelId={effectiveModelId}
                  onModelChange={(providerId, modelId) => {
                    setOverrideModel({ providerId, modelId });
                    // Effort ids are model-scoped; a previous override may not
                    // apply to the newly selected model.
                    setOverrideEffort(undefined);
                  }}
                  efforts={reasoning?.efforts ?? []}
                  effort={overrideEffort ?? parent?.reasoningEffort}
                  onEffortChange={setOverrideEffort}
                />
              </>
            }
          />
          </ConversationColumn>
        </TabsContent>
        {/* 轨迹：非 keepMounted——切走即卸载，其内部 hook 随挂载合法。 */}
        <TabsContent value="trajectory" className="flex min-h-0 flex-1 flex-col">
          <SubagentTrajectoryView
            sessionId={subTab.childSessionId}
            fileProjectId={parent?.projectId ?? null}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * 轨迹子视图：盘上快照（useStoredRows 缓存）+ 重试；错误 / legacy / 加载
 * 骨架分支逐行平移自已下线的独立轨迹标签。行点击经全局抽屉 store 打开
 * 行详情——抽屉由主轨迹面板渲染，这里只负责写入行快照。
 */
function SubagentTrajectoryView({
  sessionId,
  fileProjectId,
}: {
  sessionId: string;
  fileProjectId: string | null;
}) {
  const t = useTranslations('pane');
  const stored = useStoredRows(sessionId);
  if (stored.error !== null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p
          className={
            stored.error.kind === 'legacy'
              ? 'text-muted-foreground text-sm'
              : 'text-destructive text-sm'
          }
        >
          {stored.error.message}
        </p>
        {stored.error.kind === 'network' && (
          <Button variant="outline" size="sm" onClick={stored.retry}>
            {t('subagent.retry')}
          </Button>
        )}
      </div>
    );
  }
  if (stored.loading) {
    return (
      <div className="space-y-2 p-3">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <TrajectoryList
        rows={stored.rows ?? []}
        streamingRowId={null}
        onSelect={(row) => useTrajectoryDrawerStore.getState().open(row, fileProjectId)}
      />
    </div>
  );
}
