'use client';

import { X } from 'lucide-react';
import { useChatStore } from '@/stores/chat-store';
import { useSubagentConversation } from '@/hooks/use-subagent-conversation';
import { formatDuration } from '@/lib/trajectory-view-model';
import { MessageList } from './MessageList';

/**
 * 右侧子代理执行分栏。从 chat-store 自取 `openSubagentId` 并经
 * useSubagentConversation 合流盘上记录与实时桶；关闭只回调 `onClose`——
 * 何时落盘（closeSubagent）由宿主（ChatPanel）决定。
 *
 * 展示分支按协调约定：加载看 `feed.isLoading`（无桶首拉时 status 是
 * idle，status 不可靠）、错误看 `feed.error !== null`（拉取失败落 error
 * 字段，status 'error' 只来自桶）。
 */
export function SubagentPane({ onClose }: { onClose: () => void }) {
  const openId = useChatStore((s) => s.openSubagentId);
  const bucket = useChatStore((s) =>
    openId ? s.subagents[openId] : undefined,
  );
  const feed = useSubagentConversation(openId);

  return (
    <aside className="flex w-[420px] shrink-0 flex-col border-l">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-foreground/90 font-mono text-xs">task</span>
        <span className="text-muted-foreground text-xs">
          {bucket?.status === 'running' && '执行中'}
          {bucket?.status === 'done' &&
            (bucket.durationMs !== undefined
              ? `已完成 · ${formatDuration(bucket.durationMs)}`
              : '已完成')}
          {bucket?.status === 'error' && (
            <span className="text-destructive">失败</span>
          )}
        </span>
        {/* childSessionId 不透明，只展示不解析；截断防长 id 挤爆头部。 */}
        <span className="text-muted-foreground/60 min-w-0 flex-1 truncate font-mono text-[10px]">
          {openId}
        </span>
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="text-muted-foreground hover:bg-muted hover:text-foreground rounded p-1"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      {/* flex-col 让 MessageList 的 flex-1 生效：高度受限才能真的滚动。 */}
      <div className="flex min-h-0 flex-1 flex-col">
        {feed.isLoading ? (
          <div className="text-muted-foreground p-4 text-sm">加载执行记录…</div>
        ) : feed.error !== null ? (
          <div className="text-destructive p-4 text-sm">{feed.error}</div>
        ) : bucket !== undefined &&
          bucket.events.length === 0 &&
          bucket.status !== 'running' ? (
          <div className="text-muted-foreground p-4 text-sm">无执行记录</div>
        ) : (
          <MessageList entries={feed.entries} />
        )}
      </div>
    </aside>
  );
}
