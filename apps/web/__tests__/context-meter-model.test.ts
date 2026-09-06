import { describe, it, expect } from 'vitest';
import {
  meterPercent,
  percentTone,
  formatCompactTokens,
  segmentWidths,
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
