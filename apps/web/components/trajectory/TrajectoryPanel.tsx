'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { TrajectoryList } from './TrajectoryList';
import { TrajectoryDrawer } from './TrajectoryDrawer';
import { useTrajectory } from '@/hooks/use-trajectory';
import type { TrajectoryRow } from '@volto/sdk/sse';

interface TrajectoryPanelProps {
  /** 当前会话 id（根层级）。 */
  sessionId: string | null;
}

export function TrajectoryPanel({ sessionId }: TrajectoryPanelProps) {
  const feed = useTrajectory();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const selectedRow = feed.rows.find((r) => r.id === selectedId) ?? null;

  // 行详情回归抽屉：选中行快照存本地 state，抽屉自包含渲染。
  const onSelect = (row: TrajectoryRow) => {
    setSelectedId(row.id);
    setDrawerOpen(true);
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
          <TrajectoryList
            rows={feed.rows}
            streamingRowId={feed.streamingRowId}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        </div>
      )}

      <TrajectoryDrawer
        row={selectedRow}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
      />
    </div>
  );
}
