'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { ContextUsageView } from '@voltojs/sdk/sse';
import {
  CONTEXT_METER_SEGMENTS,
  compositionWidths,
  formatCompactTokens,
  meterPercent,
  percentTone,
  remainingTokens,
  shouldShowUnanchoredHint,
  type CompositionKey,
  type SegmentKey,
} from '@/lib/context-meter-model';

const RING_RADIUS = 5.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const SEGMENT_BG: Record<SegmentKey, string> = {
  system: 'bg-primary',
  tools: 'bg-amber-500',
  messages: 'bg-sky-500',
};

/** The bar's slices, including the unused-capacity remainder. */
const COMPOSITION_BG: Record<CompositionKey, string> = {
  ...SEGMENT_BG,
  free: 'bg-muted-foreground/15',
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
  /**
   * Whether at least one assistant turn has fully completed in this
   * conversation. Feeds shouldShowUnanchoredHint: an unanchored projection is
   * only worth flagging as "this provider isn't reporting usage" once a
   * round-trip has actually finished without one arriving — mid-first-
   * generation, no assistant message has completed yet, so the hint stays
   * hidden even though the projection is still unanchored.
   */
  hasCompletedAssistantMessage: boolean;
}

export function ContextMeter({ usage, contextWindow, hasCompletedAssistantMessage }: ContextMeterProps) {
  const t = useTranslations('chat');
  const [open, setOpen] = useState(false);
  if (!usage) return null;

  const percent = meterPercent(usage, contextWindow);
  const gray = percent === null;
  const tone = gray ? null : percentTone(percent);
  const widths = compositionWidths(usage, contextWindow);
  const remaining = remainingTokens(usage, contextWindow);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={t('usage.contextUsage')}
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
            <p className="text-sm font-medium">{t('usage.contextUnset')}</p>
            <p className="text-muted-foreground mt-1 text-xs">
              {t('usage.contextUnsetHint')}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">
              {t('usage.contextUsed', { percent })}
              {usage.anchored ? '' : t('usage.contextEstimated')}
            </p>
            <p className="text-muted-foreground mt-0.5 font-mono text-xs">
              {usage.anchored ? '' : '~'}
              {formatCompactTokens(usage.projectedTokens)} / {formatCompactTokens(contextWindow!)} tokens
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {t('usage.contextRemaining', {
                tokens: remaining === null ? '—' : `~${formatCompactTokens(remaining)}`,
              })}
            </p>
            {shouldShowUnanchoredHint(usage, hasCompletedAssistantMessage) && (
              <p className="text-muted-foreground mt-1 text-xs">
                {t('usage.contextEstimateOnly')}
              </p>
            )}
            <p className="text-muted-foreground mt-2 text-[10px] font-medium tracking-widest uppercase">
              {t('usage.breakdown')}
            </p>
            {/* The bar spans the whole window, so its trailing slice is the
                capacity still unused — not just the three buckets' share. */}
            <div className="bg-muted mt-1 flex h-1.5 overflow-hidden rounded-full">
              {widths.map((s) => (
                <div key={s.key} className={COMPOSITION_BG[s.key]} style={{ width: `${s.width}%` }} />
              ))}
            </div>
            <ul className="mt-2 space-y-1 text-xs">
              {CONTEXT_METER_SEGMENTS.map((s) => (
                <li key={s.key} className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <span className={cn('inline-block h-2 w-2 rounded-full', SEGMENT_BG[s.key])} />
                    {t(s.labelKey)}
                  </span>
                  <span className="font-mono">{formatCompactTokens(usage.breakdown[s.key])}</span>
                </li>
              ))}
              <li className="flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <span className={cn('inline-block h-2 w-2 rounded-full', COMPOSITION_BG.free)} />
                  {t('usage.unused')}
                </span>
                <span className="font-mono">
                  {remaining === null ? '—' : formatCompactTokens(remaining)}
                </span>
              </li>
            </ul>
            {usage.layers.length > 0 && (
              <div className="mt-2 border-t pt-2">
                <p className="text-muted-foreground text-[10px] font-medium tracking-widest uppercase">
                  {t('usage.systemLayers')}
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
