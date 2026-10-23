'use client';

import { Gauge } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  formatLongDuration,
  formatTps,
  formatTtft,
  type SessionStats,
} from '@/lib/session-stats-model';
import { PopoverRow } from './PopoverRow';

/**
 * Session summary in the bottom status bar: a round/step/TPS line that is
 * always on, with model time, tool time, average TTFT and output speed in
 * the hover panel (reference layout, spec 2026-10-23).
 */
export function SessionStatsChip({ stats }: { stats: SessionStats }) {
  const speed = formatTps(stats.tps);
  const summary = `${stats.turns} 轮 ${stats.steps} 步${
    speed !== null ? ` · ${speed}` : ''
  }`;

  return (
    <Popover>
      <PopoverTrigger
        aria-label="会话统计"
        className="text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[10px]"
      >
        <Gauge className="h-3 w-3" aria-hidden />
        <span>{summary}</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="max-w-[28rem]">
        <div className="flex items-center gap-1.5 border-b pb-1.5 text-xs font-medium">
          <Gauge className="h-3.5 w-3.5" aria-hidden />
          会话统计
        </div>
        <ul className="mt-2 space-y-1 text-xs">
          <PopoverRow label="模型用时" value={formatLongDuration(stats.modelMs)} />
          <PopoverRow
            label="工具调用用时"
            value={formatLongDuration(stats.toolMs)}
          />
          <PopoverRow label="首 token 平均（TTFT）" value={formatTtft(stats.avgTtftMs)} />
          <PopoverRow label="输出速度（TPS）" value={formatTps(stats.tps) ?? '—'} />
        </ul>
      </PopoverContent>
    </Popover>
  );
}
