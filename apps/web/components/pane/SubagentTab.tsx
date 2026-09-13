'use client';

import { useChatStore } from '@/stores/chat-store';
import { usePaneStore } from '@/stores/pane-store';
import { useTrajectoryDrawerStore } from '@/stores/trajectory-drawer-store';
import { useSubagentConversation } from '@/hooks/use-subagent-conversation';
import { useStoredRows } from '@/hooks/use-trajectory';
import { formatDuration } from '@/lib/trajectory-view-model';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MessageList } from '@/components/chat/MessageList';
import { TrajectoryList } from '@/components/trajectory/TrajectoryList';
import type { PaneTab } from '@/stores/pane-store';

/**
 * RightPane 的子代理标签体：对话 / 轨迹两个子视图，受控于标签载荷的
 * `view` 字段（卡片点击开对话，「查看执行过程」开轨迹——openTab 同 id
 * 覆盖载荷，本组件不持视图状态）。对话视图原样平移旧版独立执行分栏的
 * 行为矩阵（加载 → 错误+重试 → 运行中桶 → entries 空判无记录 → 列表）
 * 并 keepMounted 保滚动；轨迹视图是盘上快照（useStoredRows 缓存）。
 * 关闭职责归 RightPane 标签栏，本组件不渲染关闭按钮。
 */
export function SubagentTab({ tab }: { tab: PaneTab }) {
  // hooks 无条件调用（rules-of-hooks）：kind 窄化走三元派生，非本类标签
  // 在渲染处返回 null。tab.kind 对同一挂载实例恒定（换 kind 即换组件类型
  // → remount），钩子顺序稳定。
  const childId = tab.kind === 'subagent' ? tab.childSessionId : undefined;
  const bucket = useChatStore((s) =>
    childId !== undefined ? s.subagents[childId] : undefined,
  );
  const feed = useSubagentConversation(childId ?? null);
  if (tab.kind !== 'subagent') return null;
  // 闭包窄化：TS 不把判别联合的窄化带进回调，先提取本类标签引用再展开。
  const subTab = tab;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
        <span className="text-foreground/90 font-mono">task</span>
        <span className="text-muted-foreground">
          {bucket?.status === 'running' && '执行中'}
          {bucket?.status === 'done' &&
            (bucket.durationMs !== undefined
              ? `已完成 · ${formatDuration(bucket.durationMs)}`
              : '已完成')}
          {bucket?.status === 'error' && <span className="text-destructive">失败</span>}
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
          <TabsTrigger value="chat">对话</TabsTrigger>
          <TabsTrigger value="trajectory">轨迹</TabsTrigger>
        </TabsList>
        {/* 对话：keepMounted 保滚动；行为矩阵逐行平移自旧版独立执行分栏。 */}
        <TabsContent value="chat" keepMounted className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col">
            {feed.isLoading ? (
              <div className="text-muted-foreground p-4 text-sm">加载执行记录…</div>
            ) : feed.error !== null ? (
              <div className="flex flex-col items-start gap-3 p-4">
                <p className="text-destructive text-sm">{feed.error}</p>
                <Button variant="outline" size="sm" onClick={feed.retry}>
                  重试
                </Button>
              </div>
            ) : bucket?.status === 'running' ? (
              <MessageList entries={feed.entries} />
            ) : feed.entries.length === 0 ? (
              <div className="text-muted-foreground p-4 text-sm">无执行记录</div>
            ) : (
              <MessageList entries={feed.entries} />
            )}
          </div>
        </TabsContent>
        {/* 轨迹：非 keepMounted——切走即卸载，其内部 hook 随挂载合法。 */}
        <TabsContent value="trajectory" className="flex min-h-0 flex-1 flex-col">
          <SubagentTrajectoryView sessionId={subTab.childSessionId} />
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
function SubagentTrajectoryView({ sessionId }: { sessionId: string }) {
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
            重试
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
        onSelect={(row) => useTrajectoryDrawerStore.getState().open(row)}
      />
    </div>
  );
}
