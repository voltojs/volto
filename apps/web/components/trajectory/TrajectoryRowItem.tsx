'use client';

import { cn } from '@/lib/utils';
import {
  KIND_BADGE_CLASS,
  KIND_LABELS,
  formatDuration,
} from '@/lib/trajectory-view-model';
import type { TrajectoryRow } from '@volto/sdk/sse';

interface TrajectoryRowItemProps {
  row: TrajectoryRow;
  /** 该行是进行中的流式输出（脉冲指示点）。 */
  streaming: boolean;
  isSelected: boolean;
  onSelect: (row: TrajectoryRow) => void;
}

function locationLabel(row: TrajectoryRow): string {
  return row.step !== undefined ? `第${row.turn}轮 · 步骤${row.step}` : `第${row.turn}轮`;
}

export function TrajectoryRowItem({ row, streaming, isSelected, onSelect }: TrajectoryRowItemProps) {
  const duration = formatDuration(row.durationMs);
  return (
    <button
      type="button"
      onClick={() => onSelect(row)}
      className={cn(
        'hover:bg-muted/60 flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors',
        row.isError && 'bg-destructive/5 border-destructive/20 hover:bg-destructive/10',
        isSelected && 'bg-muted',
      )}
    >
      <span className="text-muted-foreground/70 w-8 shrink-0 font-mono text-[10px]">
        #{row.index}
      </span>
      <span
        className={cn(
          'shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium',
          KIND_BADGE_CLASS[row.kind],
        )}
      >
        {KIND_LABELS[row.kind]}
      </span>
      <span className="text-foreground/90 min-w-0 flex-1 truncate">{row.summary}</span>
      {streaming && (
        <span className="bg-primary/70 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" />
      )}
      <span className="text-muted-foreground/60 shrink-0 font-mono text-[10px]">
        {locationLabel(row)}
      </span>
      {duration && (
        <span className="text-muted-foreground/60 w-14 shrink-0 text-right font-mono text-[10px]">
          {duration}
        </span>
      )}
    </button>
  );
}
