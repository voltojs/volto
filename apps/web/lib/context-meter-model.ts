/**
 * Pure model behind the ContextMeter ring + popover: percentage, color tone
 * thresholds, compact token formatting and segment-bar widths. Node-testable
 * (no React, no DOM).
 */

import type { ContextUsageView } from '@volto/sdk/sse';

export const CONTEXT_METER_SEGMENTS = [
  { key: 'system', label: '系统提示词' },
  { key: 'tools', label: '工具' },
  { key: 'messages', label: '消息' },
] as const;

export type SegmentKey = (typeof CONTEXT_METER_SEGMENTS)[number]['key'];

/**
 * null = 窗口未配置（灰态）。
 *
 * Also guards against a non-finite window (NaN or Infinity), matching
 * remainingTokens below: an Infinity window is unreachable today
 * (contextWindow comes from validated positive-integer provider config, and
 * JSON cannot encode Infinity) so this is consistency hardening, not a bug
 * fix — without it, an Infinity window would render "0%" here while
 * remainingTokens correctly renders "—", two contradictory lines in the same
 * popover.
 */
export function meterPercent(usage: ContextUsageView, contextWindow?: number): number | null {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  return Math.min(100, Math.round((usage.projectedTokens / contextWindow) * 100));
}

export type MeterTone = 'normal' | 'warn' | 'danger';

export function percentTone(percent: number): MeterTone {
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warn';
  return 'normal';
}

/**
 * <1000 原值；≥1000 K 一位小数；≥1e6 M 一位小数。
 *
 * Does not itself guard against a non-finite `tokens` (would render
 * "InfinityM" / "NaNM"): every current call site is now shielded upstream —
 * ContextMeter only reaches these calls once meterPercent/remainingTokens
 * have already confirmed a finite, positive contextWindow. Left un-guarded
 * here to keep the fix scoped to the actual contradiction (§ meterPercent
 * above); revisit if a future call site can pass a non-finite value directly.
 */
export function formatCompactTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * Segment widths are normalised against the three segments' own total, not
 * against `projectedTokens`. `breakdown.system` / `.tools` / `.messages` are
 * three independent estimates that deliberately do not sum to the projection
 * (plan-020), so the segmented bar expresses "composition share" among the
 * three buckets — it does not represent "how full the ring is".
 */
export function segmentWidths(
  breakdown: ContextUsageView['breakdown'],
): Array<{ key: SegmentKey; width: number }> {
  const total = breakdown.system + breakdown.tools + breakdown.messages;
  if (total <= 0) return CONTEXT_METER_SEGMENTS.map((s) => ({ key: s.key, width: 0 }));
  return CONTEXT_METER_SEGMENTS.map((s) => ({ key: s.key, width: (breakdown[s.key] / total) * 100 }));
}

/**
 * Remaining context capacity: window minus the projected total, clamped to
 * zero (never negative). Returns null when no window is configured (0 counts
 * as unconfigured) or when the window is not a finite number — a NaN or
 * Infinity window would otherwise render a nonsensical remaining figure to
 * the user, which is worse than showing "—".
 */
export function remainingTokens(usage: ContextUsageView, contextWindow?: number): number | null {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  return Math.max(0, contextWindow - usage.projectedTokens);
}
