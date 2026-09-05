import { describe, it, expect } from 'vitest';
import {
  KIND_LABELS,
  KIND_BADGE_CLASS,
  formatDuration,
  drawerTabsFor,
  TAB_LABELS,
  EMPTY_CELL,
} from '@/lib/trajectory-view-model';

describe('KIND_LABELS / KIND_BADGE_CLASS', () => {
  it('covers every row kind with a zh label and badge classes', () => {
    const kinds = ['user', 'context', 'assistant', 'tool', 'subagent', 'compaction', 'error'] as const;
    for (const kind of kinds) {
      expect(KIND_LABELS[kind]).toBeTruthy();
      expect(KIND_BADGE_CLASS[kind]).toBeTruthy();
    }
    expect(KIND_LABELS.user).toBe('用户');
    expect(KIND_LABELS.error).toBe('错误');
    expect(KIND_BADGE_CLASS.error).toContain('destructive');
  });
});

describe('formatDuration', () => {
  it('returns null for absent duration', () => {
    expect(formatDuration(undefined)).toBeNull();
  });
  it('formats sub-second as ms and >=1s with one decimal', () => {
    expect(formatDuration(48)).toBe('48ms');
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1500)).toBe('1.5s');
  });
});

describe('drawerTabsFor', () => {
  it('gives tool rows the five dsh tabs', () => {
    expect(drawerTabsFor('tool')).toEqual(['overview', 'input', 'output', 'schema', 'timing']);
    expect(drawerTabsFor('subagent')).toEqual(['overview', 'input', 'output', 'schema', 'timing']);
  });
  it('gives assistant rows output + thinking', () => {
    expect(drawerTabsFor('assistant')).toEqual(['overview', 'output', 'thinking', 'timing']);
  });
  it('gives context rows layers + schema', () => {
    expect(drawerTabsFor('context')).toEqual(['overview', 'layers', 'schema']);
  });
  it('gives simple rows only the overview', () => {
    expect(drawerTabsFor('user')).toEqual(['overview']);
    expect(drawerTabsFor('compaction')).toEqual(['overview']);
    expect(drawerTabsFor('error')).toEqual(['overview']);
  });
  it('labels every tab key in zh', () => {
    expect(TAB_LABELS.overview).toBe('概述');
    expect(TAB_LABELS.input).toBe('参数');
    expect(TAB_LABELS.output).toBe('结果');
    expect(TAB_LABELS.schema).toBe('Schema');
    expect(TAB_LABELS.thinking).toBe('思考');
    expect(TAB_LABELS.layers).toBe('系统层');
    expect(TAB_LABELS.timing).toBe('计时');
    expect(EMPTY_CELL).toBe('（无）');
  });
});
