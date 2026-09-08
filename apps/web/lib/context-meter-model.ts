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

/** A composition-bar slice: one of the three buckets, or the unused remainder. */
export type CompositionKey = SegmentKey | 'free';

/**
 * Widths for the composition bar, expressed as a share of the whole context
 * window rather than of the three buckets alone — so the bar also shows how
 * much capacity is still unused (the `free` slice).
 *
 * The used share is taken from `meterPercent`, which keeps the bar and the
 * ring telling the same story, and is then split among the three buckets by
 * their own relative share. That indirection is deliberate: `breakdown` is
 * three independent estimates that do not sum to `projectedTokens`
 * (plan-020), so scaling each bucket against the window directly would
 * produce a used total that contradicts the percentage next to it.
 *
 * Without a usable window there is no "unused capacity" to speak of, so the
 * bar falls back to pure composition (no `free` slice) — the same thing it
 * showed before.
 */
export function compositionWidths(
  usage: ContextUsageView,
  contextWindow?: number,
): Array<{ key: CompositionKey; width: number }> {
  const total = usage.breakdown.system + usage.breakdown.tools + usage.breakdown.messages;
  const share = (key: SegmentKey): number => (total <= 0 ? 0 : usage.breakdown[key] / total);

  const percent = meterPercent(usage, contextWindow);
  if (percent === null) {
    return CONTEXT_METER_SEGMENTS.map((s) => ({ key: s.key as CompositionKey, width: share(s.key) * 100 }));
  }

  const used = total <= 0 ? 0 : percent;
  return [
    ...CONTEXT_METER_SEGMENTS.map((s) => ({ key: s.key as CompositionKey, width: share(s.key) * used })),
    { key: 'free' as const, width: 100 - used },
  ];
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

/**
 * True when the projection has never been anchored to a real provider
 * measurement AND at least one assistant turn has already completed. This is
 * the degradation case worth calling out — a real provider that simply
 * hasn't returned usage on the *current* in-flight turn yet must not be
 * accused of never returning it.
 *
 * `hasCompletedAssistantMessage` (not `breakdown.messages > 0`) is the right
 * gate: `request_header` (which is what flips a session out of the "nothing
 * to render yet" null state) fires at the *start* of a model call, by which
 * point the user's message has already been folded into `breakdown.messages`.
 * So `anchored === false && breakdown.messages > 0` is also true for the
 * entire first generation — several seconds where a perfectly good provider
 * simply hasn't answered yet — and the old guard showed the hint then too.
 * A completed assistant message can only exist once a full round-trip has
 * happened, so it is false throughout that window and only flips true once
 * the provider has genuinely had its chance to report usage and didn't.
 */
export function shouldShowUnanchoredHint(
  usage: ContextUsageView,
  hasCompletedAssistantMessage: boolean,
): boolean {
  return !usage.anchored && hasCompletedAssistantMessage;
}
