'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { TrajectoryList } from './TrajectoryList';
import { usePaneStore } from '@/stores/pane-store';
import { useTrajectory } from '@/hooks/use-trajectory';
import type { TrajectoryRow } from '@volto/sdk/sse';

interface TrajectoryPanelProps {
  /** 当前会话 id（根层级）。 */
  sessionId: string | null;
}

export function TrajectoryPanel({ sessionId }: TrajectoryPanelProps) {
  const feed = useTrajectory();

  // 选中行 → RightPane 开详情标签；row 快照随标签载荷存 pane-store，
  // 重读同一行即刷新（见 pane-store.openTab）。
  const onSelect = (row: TrajectoryRow) => {
    usePaneStore.getState().openTab({
      kind: 'trajectory-detail',
      id: `row:${sessionId ?? ''}:${row.id}`,
      sessionId: sessionId ?? '',
      rowId: row.id,
      row,
    });
  };

  if (sessionId === null) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        选择一个会话后查看轨迹
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {feed.error !== null ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <p
            className={
              feed.error.kind === 'legacy' ? 'text-muted-foreground text-sm' : 'text-destructive text-sm'
            }
          >
            {feed.error.message}
          </p>
          {feed.error.kind === 'network' && (
            <Button variant="outline" size="sm" onClick={feed.retry}>
              重试
            </Button>
          )}
        </div>
      ) : feed.isLoading ? (
        <div className="space-y-2 p-3">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <TrajectoryList rows={feed.rows} streamingRowId={feed.streamingRowId} onSelect={onSelect} />
        </div>
      )}
    </div>
  );
}
