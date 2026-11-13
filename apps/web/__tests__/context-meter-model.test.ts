import { describe, it, expect } from 'vitest';
import {
  meterPercent,
  percentTone,
  formatCompactTokens,
  compositionWidths,
  remainingTokens,
  shouldShowUnanchoredHint,
} from '@/lib/context-meter-model';
import type { ContextUsageView } from '@voltojs/sdk/sse';

const view = (projectedTokens: number): ContextUsageView => ({
  projectedTokens,
  breakdown: { system: 3, tools: 2, messages: Math.max(0, projectedTokens - 5) },
  layers: [],
  anchored: true,
});

describe('meterPercent', () => {
  it('computes and clamps the percentage', () => {
    expect(meterPercent(view(100), 200)).toBe(50);
    expect(meterPercent(view(300), 200)).toBe(100);
  });
  it('returns null without a positive window (gray state)', () => {
    expect(meterPercent(view(100), undefined)).toBeNull();
    expect(meterPercent(view(100), 0)).toBeNull();
  });
  it('returns null for a non-finite window, matching remainingTokens', () => {
    expect(meterPercent(view(100), Number.POSITIVE_INFINITY)).toBeNull();
    expect(meterPercent(view(100), Number.NaN)).toBeNull();
  });
});

describe('percentTone', () => {
  it('thresholds at 70 and 90', () => {
    expect(percentTone(69)).toBe('normal');
    expect(percentTone(70)).toBe('warn');
    expect(percentTone(89)).toBe('warn');
    expect(percentTone(90)).toBe('danger');
  });
});

describe('formatCompactTokens', () => {
  it('formats raw / K / M', () => {
    expect(formatCompactTokens(999)).toBe('999');
    expect(formatCompactTokens(1000)).toBe('1.0K');
    expect(formatCompactTokens(12345)).toBe('12.3K');
    expect(formatCompactTokens(2_500_000)).toBe('2.5M');
  });
});

describe('compositionWidths', () => {
  const withBreakdown = (
    breakdown: ContextUsageView['breakdown'],
    projectedTokens: number,
  ): ContextUsageView => ({ projectedTokens, breakdown, layers: [], anchored: true });

  it('splits by breakdown share when no window is configured (no free slice)', () => {
    const widths = compositionWidths(
      withBreakdown({ system: 25, tools: 25, messages: 50 }, 100),
      undefined,
    );
    expect(widths.map((s) => s.key)).toEqual(['system', 'tools', 'messages']);
    expect(widths.map((s) => s.width)).toEqual([25, 25, 50]);
  });

  it('returns all-zero widths for an empty total', () => {
    const widths = compositionWidths(withBreakdown({ system: 0, tools: 0, messages: 0 }, 0), undefined);
    expect(widths.map((s) => s.width)).toEqual([0, 0, 0]);
  });

  it('scales the buckets to the used share and adds the unused remainder', () => {
    // 40 projected of a 200-token window → 20% used, split 25/25/50 among
    // the buckets, leaving 80% free.
    const widths = compositionWidths(withBreakdown({ system: 10, tools: 10, messages: 20 }, 40), 200);
    expect(widths.map((s) => s.key)).toEqual(['system', 'tools', 'messages', 'free']);
    expect(widths.map((s) => s.width)).toEqual([5, 5, 10, 80]);
  });

  it('leaves no free slice once the window is full', () => {
    const widths = compositionWidths(withBreakdown({ system: 10, tools: 10, messages: 20 }, 400), 200);
    expect(widths.at(-1)).toEqual({ key: 'free', width: 0 });
  });

  it('shows a fully free bar for a window with nothing in it yet', () => {
    const widths = compositionWidths(withBreakdown({ system: 0, tools: 0, messages: 0 }, 0), 200);
    expect(widths.map((s) => s.width)).toEqual([0, 0, 0, 100]);
  });
});

describe('remainingTokens', () => {
  const usage = (projected: number): ContextUsageView => ({
    projectedTokens: projected,
    breakdown: { system: 10, tools: 5, messages: 20 },
    layers: [],
    anchored: true,
  });

  it('returns the window minus the projection', () => {
    expect(remainingTokens(usage(1000), 8000)).toBe(7000);
  });

  it('clamps to zero when the projection exceeds the window', () => {
    expect(remainingTokens(usage(9000), 8000)).toBe(0);
  });

  it('returns null when no window is configured', () => {
    expect(remainingTokens(usage(1000), undefined)).toBeNull();
    expect(remainingTokens(usage(1000), 0)).toBeNull();
  });

  it('returns null for a non-finite window instead of a nonsensical remaining figure', () => {
    expect(remainingTokens(usage(1000), Number.NaN)).toBeNull();
    expect(remainingTokens(usage(1000), Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('compositionWidths with an unreconciled breakdown', () => {
  it('splits the used share by bucket ratio, not by each bucket against the window', () => {
    // The three buckets sum to 40 while the projection is 100: scaling each
    // bucket against the window directly would understate the used share and
    // contradict the percentage shown beside the bar.
    const usage: ContextUsageView = {
      projectedTokens: 100,
      breakdown: { system: 10, tools: 10, messages: 20 },
      layers: [],
      anchored: true,
    };
    const widths = compositionWidths(usage, 200);
    expect(widths.map((w) => Math.round(w.width))).toEqual([13, 13, 25, 50]);
  });
});

describe('shouldShowUnanchoredHint', () => {
  const baseView = (overrides: Partial<ContextUsageView>): ContextUsageView => ({
    projectedTokens: 100,
    breakdown: { system: 3, tools: 2, messages: 95 },
    layers: [],
    anchored: false,
    ...overrides,
  });

  it('renders when unanchored and an assistant message has already completed', () => {
    expect(shouldShowUnanchoredHint(baseView({}), true)).toBe(true);
  });

  it('does not render when anchored, even with a completed assistant message', () => {
    expect(shouldShowUnanchoredHint(baseView({ anchored: true }), true)).toBe(false);
  });

  it(
    'does not render mid-first-generation: unanchored, messages > 0, but no assistant ' +
      'response has completed yet',
    () => {
      // breakdown.messages > 0 here because request_header (which flips the
      // meter out of its null state) fires after the user_message has
      // already been folded — this is the exact state during the entire
      // first generation, before any assistant reply has landed. The old
      // predicate (`!anchored && breakdown.messages > 0`) wrongly returned
      // true here.
      expect(shouldShowUnanchoredHint(baseView({}), false)).toBe(false);
    },
  );

  it('does not render on a fresh session with nothing in it', () => {
    expect(
      shouldShowUnanchoredHint(
        baseView({ projectedTokens: 0, breakdown: { system: 0, tools: 0, messages: 0 } }),
        false,
      ),
    ).toBe(false);
  });
});
