import { describe, it, expect } from 'vitest';
import {
  meterPercent,
  percentTone,
  formatCompactTokens,
  segmentWidths,
  remainingTokens,
} from '@/lib/context-meter-model';
import type { ContextUsageView } from '@volto/sdk/sse';

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

describe('segmentWidths', () => {
  it('splits by breakdown share', () => {
    const widths = segmentWidths({ system: 25, tools: 25, messages: 50 });
    expect(widths.map((s) => s.width)).toEqual([25, 25, 50]);
  });
  it('returns all-zero widths for an empty total', () => {
    const widths = segmentWidths({ system: 0, tools: 0, messages: 0 });
    expect(widths.map((s) => s.width)).toEqual([0, 0, 0]);
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

describe('segmentWidths with an unreconciled breakdown', () => {
  it('normalises against the three segments, not the projection', () => {
    const widths = segmentWidths({ system: 10, tools: 10, messages: 20 });
    expect(widths.map((w) => Math.round(w.width))).toEqual([25, 25, 50]);
  });
});
