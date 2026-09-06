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

/** null = 窗口未配置（灰态）。 */
export function meterPercent(usage: ContextUsageView, contextWindow?: number): number | null {
  if (!contextWindow || contextWindow <= 0) return null;
  return Math.min(100, Math.round((usage.projectedTokens / contextWindow) * 100));
}

export type MeterTone = 'normal' | 'warn' | 'danger';

export function percentTone(percent: number): MeterTone {
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warn';
  return 'normal';
}

/** <1000 原值；≥1000 K 一位小数；≥1e6 M 一位小数。 */
export function formatCompactTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function segmentWidths(
  breakdown: ContextUsageView['breakdown'],
): Array<{ key: SegmentKey; width: number }> {
  const total = breakdown.system + breakdown.tools + breakdown.messages;
  if (total <= 0) return CONTEXT_METER_SEGMENTS.map((s) => ({ key: s.key, width: 0 }));
  return CONTEXT_METER_SEGMENTS.map((s) => ({ key: s.key, width: (breakdown[s.key] / total) * 100 }));
}
