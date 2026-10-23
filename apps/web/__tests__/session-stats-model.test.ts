/**
 * The bottom status bar's pure aggregation over trajectory rows
 * (spec: session stats + whole-conversation token usage). No React, no IO —
 * components only render what these return.
 */
import { describe, it, expect } from 'vitest';
import {
  conversationUsage,
  formatLongDuration,
  sessionStats,
} from '@/lib/session-stats-model';
import type { TrajectoryRow } from '@volto/sdk/sse';

type RowInput = Partial<TrajectoryRow> &
  Pick<TrajectoryRow, 'id' | 'kind' | 'turn'>;

let seq = 0;
function row(input: RowInput): TrajectoryRow {
  seq += 1;
  return {
    index: seq,
    summary: '',
    startedAt: seq * 1000,
    step: 1,
    ...input,
  } as TrajectoryRow;
}

function assistant(
  metrics?: TrajectoryRow['metrics'],
  over: Partial<TrajectoryRow> = {},
): TrajectoryRow {
  // `turn` stays required through the spread: Partial would otherwise widen
  // it to number | undefined, which RowInput (and the projection) reject.
  return row({
    ...over,
    id: `a${seq}`,
    kind: 'assistant',
    turn: over.turn ?? 1,
    metrics,
  });
}

describe('sessionStats', () => {
  it('counts distinct turns and model-call steps', () => {
    const rows = [
      row({ id: 'u1', kind: 'user', turn: 1, step: undefined }),
      assistant(undefined, { turn: 1, step: 1 }),
      row({ id: 't1', kind: 'tool', turn: 1, step: 1, durationMs: 40 }),
      // Same step, second model row: must not double-count.
      assistant(undefined, { turn: 1, step: 1 }),
      assistant(undefined, { turn: 1, step: 2 }),
      assistant(undefined, { turn: 2, step: 1 }),
    ];

    const stats = sessionStats(rows);
    expect(stats.turns).toBe(2);
    expect(stats.steps).toBe(3);
  });

  it('sums model time and tool time separately', () => {
    const rows = [
      assistant({ durationMs: 80 }, { turn: 1 }),
      assistant({ durationMs: 20 }, { turn: 1 }),
      row({ id: 't1', kind: 'tool', turn: 1, durationMs: 40 }),
      row({ id: 't2', kind: 'tool', turn: 1, durationMs: 10 }),
      // Rows without timings contribute nothing.
      row({ id: 'u1', kind: 'user', turn: 1, step: undefined }),
      row({ id: 'c1', kind: 'context', turn: 1, step: undefined }),
    ];

    const stats = sessionStats(rows);
    expect(stats.modelMs).toBe(100);
    expect(stats.toolMs).toBe(50);
  });

  it('averages TTFT only over calls that reported one', () => {
    const rows = [
      assistant({ durationMs: 900, ttftMs: 100 }, { turn: 1 }),
      assistant({ durationMs: 900, ttftMs: 300 }, { turn: 1 }),
      // Reported duration but no ttft (e.g. streamed none): excluded.
      assistant({ durationMs: 900 }, { turn: 1 }),
    ];

    expect(sessionStats(rows).avgTtftMs).toBe(200);
    expect(sessionStats([]).avgTtftMs).toBeNull();
  });

  it('derives TPS from output tokens over model time, null without time', () => {
    const rows = [
      assistant(
        { durationMs: 3000, usage: { inputTokens: 10, outputTokens: 600 } },
        { turn: 1 },
      ),
      assistant(
        { durationMs: 2000, usage: { inputTokens: 10, outputTokens: 400 } },
        { turn: 1 },
      ),
    ];

    const stats = sessionStats(rows);
    expect(stats.outputTokens).toBe(1000);
    expect(stats.tps).toBe(200);

    expect(sessionStats([]).tps).toBeNull();
  });
});

describe('conversationUsage', () => {
  it('sums usage across every model call of the conversation', () => {
    const rows = [
      assistant(
        {
          durationMs: 100,
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 900,
            cacheWriteTokens: 100,
          },
        },
        { turn: 1 },
      ),
      // Provider reported no cache fields on this call.
      assistant(
        { durationMs: 100, usage: { inputTokens: 50, outputTokens: 25 } },
        { turn: 2 },
      ),
      // Metrics arrived without usage: counted as a missing call, not 0.
      assistant({ durationMs: 100 }, { turn: 3 }),
      // Still streaming (no metrics yet): neither usage nor missing.
      assistant(undefined, { turn: 4 }),
    ];

    const usage = conversationUsage(rows);
    expect(usage.inputTokens).toBe(150);
    expect(usage.outputTokens).toBe(75);
    expect(usage.cacheReadTokens).toBe(900);
    expect(usage.cacheWriteTokens).toBe(100);
    expect(usage.totalTokens).toBe(1225);
    expect(usage.missingUsageCalls).toBe(1);
  });

  it('returns zeroed usage for an empty feed', () => {
    const usage = conversationUsage([]);
    expect(usage.totalTokens).toBe(0);
    expect(usage.missingUsageCalls).toBe(0);
  });
});

describe('long-duration formatting (status bar + panel)', () => {
  it('formats sub-second, seconds and minutes like the reference panel', () => {
    expect(formatLongDuration(500)).toBe('500ms');
    expect(formatLongDuration(1300)).toBe('1.3秒');
    expect(formatLongDuration(45_000)).toBe('45.0秒');
    // The reference shows 61分4秒 — minutes are never rolled into hours.
    expect(formatLongDuration(3_664_000)).toBe('61分4秒');
    expect(formatLongDuration(0)).toBe('0ms');
  });
});
