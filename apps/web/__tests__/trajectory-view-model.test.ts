import { describe, it, expect } from 'vitest';
import {
  KIND_LABEL_KEYS,
  KIND_BADGE_CLASS,
  formatDuration,
  drawerTabsFor,
  tabLabelKey,
  TAB_LABEL_KEYS,
  locationTextRef,
  parseSystemLayers,
  REMINDER_KIND_LABEL_KEYS,
  USER_SOURCE_LABEL_KEYS,
  userSourceLabelKey,
} from '@/lib/trajectory-view-model';
import type { TrajectoryRow, ContextReminderKind } from '@voltojs/sdk/sse';

describe('KIND_LABEL_KEYS / KIND_BADGE_CLASS', () => {
  it('covers every row kind with a catalog key and badge classes', () => {
    const kinds = ['user', 'context', 'assistant', 'tool', 'subagent', 'compaction', 'error', 'reminder'] as const;
    for (const kind of kinds) {
      expect(KIND_LABEL_KEYS[kind]).toBeTruthy();
      expect(KIND_BADGE_CLASS[kind]).toBeTruthy();
    }
    expect(KIND_LABEL_KEYS.user).toBe('kind.user');
    expect(KIND_LABEL_KEYS.error).toBe('kind.error');
    expect(KIND_BADGE_CLASS.error).toContain('destructive');
  });
});

describe('USER_SOURCE_LABEL_KEYS', () => {
  it('maps each user message source to a catalog key', () => {
    expect(USER_SOURCE_LABEL_KEYS['subagent-task']).toBe('source.subagentTask');
    expect(USER_SOURCE_LABEL_KEYS['host-continuation']).toBe('source.hostContinuation');
  });

  it('falls back to a generic label for an unknown source kind', () => {
    expect(userSourceLabelKey('future-source')).toBe('source.unknown');
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
    expect(locationTextRef(row(3))).toEqual({
      key: 'location.step',
      params: { turn: 2, step: 3 },
    });
    expect(locationTextRef(row())).toEqual({
      key: 'location.turn',
      params: { turn: 2 },
    });
  });
});

describe('drawerTabsFor', () => {
  it('gives tool rows the five dsh tabs', () => {
    expect(drawerTabsFor('tool')).toEqual(['overview', 'input', 'output', 'schema', 'timing']);
    expect(drawerTabsFor('subagent')).toEqual(['overview', 'input', 'output', 'schema', 'timing']);
  });
  it('gives assistant rows request + output + thinking', () => {
    expect(drawerTabsFor('assistant')).toEqual(['overview', 'request', 'output', 'thinking', 'timing']);
  });
  it('gives context rows layers + schema', () => {
    expect(drawerTabsFor('context')).toEqual(['overview', 'layers', 'schema']);
  });
  it('gives simple rows only the overview', () => {
    expect(drawerTabsFor('error')).toEqual(['overview']);
  });
  it('gives user rows a content tab so the full message is readable', () => {
    // The summary is truncated; inputDetail carries the whole user message
    // (and the whole dispatch prompt for a sub-agent's turn-0 row).
    expect(drawerTabsFor('user')).toEqual(['overview', 'input']);
    expect(tabLabelKey('user', 'input')).toBe('tab.content');
    // Tool rows keep the arguments wording.
    expect(tabLabelKey('tool', 'input')).toBe('tab.input');
  });
  it('labels the workspace reminder', () => {
    expect(REMINDER_KIND_LABEL_KEYS.workspace).toBe('reminder.workspace');
    // Full text stays readable in the drawer, same as every other reminder.
    expect(drawerTabsFor('reminder')).toEqual(['overview', 'output']);
  });
  it('gives reminder and compaction rows an output tab so the full text is readable', () => {
    expect(drawerTabsFor('reminder')).toEqual(['overview', 'output']);
    expect(drawerTabsFor('compaction')).toEqual(['overview', 'output']);
  });
  it('maps every tab key to a catalog key', () => {
    expect(TAB_LABEL_KEYS.overview).toBe('tab.overview');
    expect(TAB_LABEL_KEYS.input).toBe('tab.input');
    expect(TAB_LABEL_KEYS.output).toBe('tab.output');
    expect(TAB_LABEL_KEYS.schema).toBe('tab.schema');
    expect(TAB_LABEL_KEYS.thinking).toBe('tab.thinking');
    expect(TAB_LABEL_KEYS.layers).toBe('tab.layers');
    expect(TAB_LABEL_KEYS.timing).toBe('tab.timing');
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

describe('REMINDER_KIND_LABEL_KEYS', () => {
  it('covers every ContextReminderKind with a catalog key', () => {
    const kinds: ContextReminderKind[] = ['permission_boundary', 'self_correction', 'retrieval'];
    for (const kind of kinds) {
      expect(REMINDER_KIND_LABEL_KEYS[kind]).toBeTruthy();
    }
    expect(REMINDER_KIND_LABEL_KEYS.permission_boundary).toBe(
      'reminder.permission_boundary',
    );
  });
});
