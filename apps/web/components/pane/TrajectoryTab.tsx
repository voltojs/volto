'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { TrajectoryList } from '@/components/trajectory/TrajectoryList';
import { useStoredRows } from '@/hooks/use-trajectory';
import type { PaneTab } from '@/stores/pane-store';

/**
 * RightPane 的轨迹标签：某会话（实践中为子会话）的审计行列表。盘上快照
 * 语义（useStoredRows 缓存），无实时合并、无下钻——实时对话流走 subagent
 * 标签，两者分工明确。
 */
export function TrajectoryTab({ tab }: { tab: PaneTab }) {
  const sessionId = tab.kind === 'trajectory' ? tab.sessionId : null;
  const feed = useStoredRows(sessionId);
  if (tab.kind !== 'trajectory' || sessionId === null) return null;
  if (feed.error !== null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className={feed.error.kind === 'legacy' ? 'text-muted-foreground text-sm' : 'text-destructive text-sm'}>
          {feed.error.message}
        </p>
        {feed.error.kind === 'network' && (
          <Button variant="outline" size="sm" onClick={feed.retry}>
            重试
          </Button>
        )}
      </div>
    );
  }
  if (feed.loading) {
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
      <TrajectoryList rows={feed.rows ?? []} streamingRowId={null} />
    </div>
  );
}
