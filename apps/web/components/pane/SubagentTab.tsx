'use client';

import { useChatStore } from '@/stores/chat-store';
import { useSubagentConversation } from '@/hooks/use-subagent-conversation';
import { formatDuration } from '@/lib/trajectory-view-model';
import { Button } from '@/components/ui/button';
import { MessageList } from '@/components/chat/MessageList';
import type { PaneTab } from '@/stores/pane-store';

/**
 * RightPane 的子代理标签体——SubagentPane 内容体平移（行为矩阵逐行保留：
 * 加载 → 错误+重试 → 运行中桶 → entries 空判无记录 → 列表）。关闭职责归
 * RightPane 标签栏，本组件不再渲染关闭按钮。
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
    </div>
  );
}
