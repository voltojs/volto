'use client';

import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { ContextUsageView } from '@volto/sdk/sse';
import {
  CONTEXT_METER_SEGMENTS,
  formatCompactTokens,
  meterPercent,
  percentTone,
  remainingTokens,
  segmentWidths,
  type SegmentKey,
} from '@/lib/context-meter-model';

const RING_RADIUS = 5.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const SEGMENT_BG: Record<SegmentKey, string> = {
  system: 'bg-primary',
  tools: 'bg-amber-500',
  messages: 'bg-sky-500',
};

const TONE_TEXT = {
  normal: 'text-primary',
  warn: 'text-amber-500',
  danger: 'text-destructive',
} as const;

interface ContextMeterProps {
  /** null → the ring is not rendered at all (nothing projected yet). */
  usage: ContextUsageView | null;
  /** 当前模型的上下文窗口（tokens）；缺省 → 灰态 + 引导。 */
  contextWindow?: number;
}

export function ContextMeter({ usage, contextWindow }: ContextMeterProps) {
  const [open, setOpen] = useState(false);
  if (!usage) return null;

  const percent = meterPercent(usage, contextWindow);
  const gray = percent === null;
  const tone = gray ? null : percentTone(percent);
  const widths = segmentWidths(usage.breakdown);
  const remaining = remainingTokens(usage, contextWindow);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="上下文用量"
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px] font-medium"
      >
        <svg
          viewBox="0 0 14 14"
          className={cn('-rotate-90 h-3.5 w-3.5', tone ? TONE_TEXT[tone] : 'text-muted-foreground/50')}
          aria-hidden
        >
          <circle cx="7" cy="7" r={RING_RADIUS} fill="none" strokeWidth="3" className="stroke-border" />
          {percent !== null && (
            <circle
              cx="7"
              cy="7"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={`${(RING_CIRCUMFERENCE * percent) / 100} ${RING_CIRCUMFERENCE}`}
              className="stroke-current"
            />
          )}
        </svg>
        <span className={cn(tone && TONE_TEXT[tone])}>{gray ? '—' : `${percent}%`}</span>
      </PopoverTrigger>
      <PopoverContent className="w-72">
        {gray ? (
          <>
            <p className="text-sm font-medium">上下文窗口未设置</p>
            <p className="text-muted-foreground mt-1 text-xs">
              在「模型配置」中为当前模型添加上下文窗口（tokens）后，这里会显示上下文占用百分比与构成明细。
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">
              上下文已用 {percent}%{usage.anchored ? '' : '（估算）'}
            </p>
            <p className="text-muted-foreground mt-0.5 font-mono text-xs">
              {usage.anchored ? '' : '~'}
              {formatCompactTokens(usage.projectedTokens)} / {formatCompactTokens(contextWindow!)} tokens
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              剩余 {remaining === null ? '—' : `~${formatCompactTokens(remaining)}`}
            </p>
            <p className="text-muted-foreground mt-2 text-[10px] font-medium tracking-widest uppercase">
              构成（估算）
            </p>
            <div className="bg-muted mt-1 flex h-1.5 overflow-hidden rounded-full">
              {widths.map((s) => (
                <div key={s.key} className={SEGMENT_BG[s.key]} style={{ width: `${s.width}%` }} />
              ))}
            </div>
            <ul className="mt-2 space-y-1 text-xs">
              {CONTEXT_METER_SEGMENTS.map((s) => (
                <li key={s.key} className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <span className={cn('inline-block h-2 w-2 rounded-full', SEGMENT_BG[s.key])} />
                    {s.label}
                  </span>
                  <span className="font-mono">{formatCompactTokens(usage.breakdown[s.key])}</span>
                </li>
              ))}
            </ul>
            {usage.layers.length > 0 && (
              <div className="mt-2 border-t pt-2">
                <p className="text-muted-foreground text-[10px] font-medium tracking-widest uppercase">
                  系统分层（估算）
                </p>
                <ul className="mt-1 space-y-1 text-xs">
                  {usage.layers.map((layer) => (
                    <li key={layer.id} className="flex items-center justify-between gap-2">
                      <code className="text-muted-foreground truncate font-mono">{layer.id}</code>
                      <span className="font-mono">{formatCompactTokens(layer.tokens)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
