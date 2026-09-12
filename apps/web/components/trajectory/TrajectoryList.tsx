'use client';

import { ScrollArea } from '@/components/ui/scroll-area';
import { TrajectoryRowItem } from './TrajectoryRowItem';
import type { TrajectoryRow } from '@volto/sdk/sse';

interface TrajectoryListProps {
  rows: TrajectoryRow[];
  streamingRowId: string | null;
  /** 选中高亮 + 点击回调：无选中语义的列表（如 pane 的轨迹快照标签）可省。 */
  selectedId?: string | null;
  onSelect?: (row: TrajectoryRow) => void;
  /** 行数为零时的占位文案。 */
  emptyHint?: string;
}

export function TrajectoryList({
  rows,
  streamingRowId,
  selectedId,
  onSelect,
  emptyHint = '本会话还没有可展示的事件',
}: TrajectoryListProps) {
  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center px-6 text-center text-sm">
        {emptyHint}
      </div>
    );
  }
  return (
    <ScrollArea className="h-full">
      <div className="divide-y">
        {rows.map((row) => (
          <TrajectoryRowItem
            key={row.id}
            row={row}
            streaming={row.id === streamingRowId}
            isSelected={row.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
