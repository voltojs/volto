/**
 * Pure aggregation behind the bottom status bar: whole-conversation session
 * stats (rounds, model-call steps, model/tool wall time, average TTFT, output
 * speed) and conversation-wide token usage, both folded from the trajectory
 * rows — the one projection that carries per-call metrics and usage.
 *
 * No React, no IO: components only render what these return. Follows the
 * context-meter-model / turn-usage-model layering (pure functions + own
 * tests; components never inline arithmetic).
 */
import type { TrajectoryRow, TurnUsage } from '@volto/sdk/sse';

export interface SessionStats {
  /** Distinct turns that left at least one row. */
  turns: number;
  /** Distinct `turn:step` pairs — one model call each. */
  steps: number;
  /** Σ assistant `metrics.durationMs` — time spent inside model calls. */
  modelMs: number;
  /** Σ tool-row `durationMs` — time spent executing tools. */
  toolMs: number;
  /** Mean of reported TTFTs; null when no call reported one. */
  avgTtftMs: number | null;
  /** Σ assistant `metrics.usage.outputTokens`. */
  outputTokens: number;
  /** Output tokens per second of model time; null without model time. */
  tps: number | null;
}

function isAssistant(row: TrajectoryRow): boolean {
  return row.kind === 'assistant';
}

export function sessionStats(rows: readonly TrajectoryRow[]): SessionStats {
  const turns = new Set<number>();
  const steps = new Set<string>();
  let modelMs = 0;
  let toolMs = 0;
  let ttftTotalMs = 0;
  let ttftCount = 0;
  let outputTokens = 0;

  for (const row of rows) {
    turns.add(row.turn);
    if (row.step !== undefined) steps.add(`${row.turn}:${row.step}`);

    if (row.kind === 'tool') {
      toolMs += row.durationMs ?? 0;
      continue;
    }
    if (!isAssistant(row)) continue;

    const metrics = row.metrics;
    if (metrics === undefined) continue;
    modelMs += metrics.durationMs;
    if (metrics.ttftMs !== undefined) {
      ttftTotalMs += metrics.ttftMs;
      ttftCount += 1;
    }
    outputTokens += metrics.usage?.outputTokens ?? 0;
  }

  return {
    turns: turns.size,
    steps: steps.size,
    modelMs,
    toolMs,
    avgTtftMs: ttftCount > 0 ? ttftTotalMs / ttftCount : null,
    outputTokens,
    tps: modelMs > 0 ? outputTokens / (modelMs / 1000) : null,
  };
}

/**
 * Whole-conversation usage in the TurnUsage shape (the breakdown rows and
 * cache-hit maths in turn-usage-model apply unchanged). No `source`: a
 * conversation can span providers/models, so a single route would lie.
 * A call whose metrics arrived without usage counts as missing — the same
 * footnote semantics as the per-round chip; a still-streaming row (no
 * metrics) counts as neither.
 */
export function conversationUsage(
  rows: readonly TrajectoryRow[],
): TurnUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let missingUsageCalls = 0;

  for (const row of rows) {
    if (!isAssistant(row) || row.metrics === undefined) continue;
    const usage = row.metrics.usage;
    if (usage === undefined) {
      missingUsageCalls += 1;
      continue;
    }
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens ?? 0;
    cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    missingUsageCalls,
  };
}

/**
 * Long-form duration for the status bar and its panel, matching the
 * reference: ms below a second, one-decimal seconds below a minute, then
 * minutes — never rolled into hours (the reference reads 61分4秒, not 1小时1分).
 */
export function formatLongDuration(
  ms: number,
  t: (key: string, params?: Record<string, string | number>) => string = (key) => key,
): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return t('durations.seconds', { value: (ms / 1000).toFixed(1) });
  return t('durations.minutes', {
    minutes: Math.floor(ms / 60_000),
    seconds: Math.floor((ms % 60_000) / 1000),
  });
}

/** Average TTFT for the panel: '1.3秒'; null → '—' (no reported TTFT). */
export function formatTtft(
  avgTtftMs: number | null,
  t: (key: string, params?: Record<string, string | number>) => string = (key) => key,
): string {
  if (avgTtftMs === null) return '—';
  return formatLongDuration(avgTtftMs, t);
}

/** Whole number with unit for the summaries: '205 tok/s'; null → null. */
export function formatTps(tps: number | null): string | null {
  if (tps === null) return null;
  return `${Math.round(tps)} tok/s`;
}
