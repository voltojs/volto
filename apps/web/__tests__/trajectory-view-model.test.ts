import { describe, it, expect } from 'vitest';
import {
  KIND_LABELS,
  KIND_BADGE_CLASS,
  formatDuration,
  drawerTabsFor,
  TAB_LABELS,
  EMPTY_CELL,
  locationLabel,
  parseSystemLayers,
  REMINDER_KIND_LABELS,
} from '@/lib/trajectory-view-model';
import type { TrajectoryRow, ContextReminderKind } from '@volto/sdk/sse';

describe('KIND_LABELS / KIND_BADGE_CLASS', () => {
  it('covers every row kind with a zh label and badge classes', () => {
    const kinds = ['user', 'context', 'assistant', 'tool', 'subagent', 'compaction', 'error', 'reminder'] as const;
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

describe('locationLabel', () => {
  const row = (step?: number): TrajectoryRow =>
    ({
      index: 1,
      id: 'r',
      kind: 'assistant',
      turn: 2,
      ...(step !== undefined ? { step } : {}),
      summary: 's',
      startedAt: 0,
    }) as TrajectoryRow;

  it('includes the step when present and falls back to the turn alone', () => {
    expect(locationLabel(row(3))).toBe('第2轮 · 步骤3');
    expect(locationLabel(row())).toBe('第2轮');
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
    expect(drawerTabsFor('error')).toEqual(['overview']);
  });
  it('gives reminder and compaction rows an output tab so the full text is readable', () => {
    expect(drawerTabsFor('reminder')).toEqual(['overview', 'output']);
    expect(drawerTabsFor('compaction')).toEqual(['overview', 'output']);
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

describe('parseSystemLayers', () => {
  it('splits sentinel-framed layers with byte counts', () => {
    const input = [
      '<<<layer id="user-memory" bytes="4">>>\nUser',
      '<<<layer id="project-memory:AGENTS.md" bytes="12">>>\nProject rule',
    ].join('\n\n');
    expect(parseSystemLayers(input)).toEqual([
      { id: 'user-memory', text: 'User' },
      { id: 'project-memory:AGENTS.md', text: 'Project rule' },
    ]);
  });

  it('groups multi-paragraph layer content with blank lines and markdown headings', () => {
    const input = [
      '<<<layer id="project-memory:AGENTS.md" bytes="22">>>\nIntro.\n\n## Rules\n\nBody',
    ].join('\n');
    expect(parseSystemLayers(input)).toEqual([
      { id: 'project-memory:AGENTS.md', text: 'Intro.\n\n## Rules\n\nBody' },
    ]);
  });

  it('handles a trailing-newline layer followed by another layer', () => {
    const input = [
      '<<<layer id="user-memory" bytes="5">>>\nUser\n',
      '<<<layer id="skill:x" bytes="4">>>\nBody',
    ].join('\n\n');
    expect(parseSystemLayers(input)).toEqual([
      { id: 'user-memory', text: 'User\n' },
      { id: 'skill:x', text: 'Body' },
    ]);
  });

  it('returns [] for legacy or unexpected formats', () => {
    expect(parseSystemLayers('## user-memory\nUser\n\n## project-memory\nX')).toEqual([]);
    expect(parseSystemLayers('')).toEqual([]);
  });
});

describe('REMINDER_KIND_LABELS', () => {
  it('covers every ContextReminderKind with a zh label', () => {
    const kinds: ContextReminderKind[] = ['permission_boundary', 'self_correction', 'retrieval'];
    for (const kind of kinds) {
      expect(REMINDER_KIND_LABELS[kind]).toBeTruthy();
    }
    expect(REMINDER_KIND_LABELS.permission_boundary).toBe('权限边界');
  });
});
