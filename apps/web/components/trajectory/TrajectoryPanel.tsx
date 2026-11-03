'use client';

import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { TrajectoryList } from './TrajectoryList';
import { TrajectoryDrawer } from './TrajectoryDrawer';
import { useTrajectory } from '@/hooks/use-trajectory';
import { useTrajectoryDrawerStore } from '@/stores/trajectory-drawer-store';

interface TrajectoryPanelProps {
  /** 当前会话 id（根层级）。 */
  sessionId: string | null;
}

export function TrajectoryPanel({ sessionId }: TrajectoryPanelProps) {
  const feed = useTrajectory();
  // 行详情抽屉为全局状态：主轨迹面板与子代理详情的轨迹子视图打开同一
  // 个抽屉；本列表的行高亮跟随抽屉当前行。
  const drawerRow = useTrajectoryDrawerStore((s) => s.row);
  const openDrawer = useTrajectoryDrawerStore((s) => s.open);
  const closeDrawer = useTrajectoryDrawerStore((s) => s.close);

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
            selectedId={drawerRow?.id ?? null}
            onSelect={openDrawer}
          />
        </div>
      )}

      <TrajectoryDrawer
        row={drawerRow}
        open={drawerRow !== null}
        onOpenChange={(open) => {
          if (!open) closeDrawer();
        }}
      />
    </div>
  );
}
