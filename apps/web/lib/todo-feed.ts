/**
 * Merge of stored and live todo transitions into the rows the chat feed draws.
 *
 * Two sources exist for the same history: the server folds it from the durable
 * log (`GET /sessions/:id` → `todoChanges`, so a reload keeps it), and the live
 * SSE buffer folds it as a turn runs. They overlap whenever an event landed on
 * both sides, and there is no `seq` on the client — SSE frames carry
 * `TranscriptEventInput` only — so identity comes from the event itself:
 * `turn:time:kind:content`, with a missing turn folding to `0` so the key
 * always starts with a number (the feed reads the leading segment back as the
 * entry's turn). Live wins on a collision, mirroring how the feed merges
 * messages by id.
 */

import { foldTodoTransitions } from '@volto/sdk/sse';
import type { TodoTransition, TodoTransitionRecord } from '@volto/sdk/sse';

/** The part of a transcript event this module folds. */
interface TodoEvent {
  type: string;
  data: unknown;
  time?: number;
  turn?: number;
}

/** One rendered progress line. */
export interface TodoFeedRow {
  key: string;
  transition: TodoTransition;
  time: number;
}

/** Stable identity of one change, derived from fields both sources carry. */
export function todoTransitionKey(row: {
  turn?: number;
  time: number;
  transition: TodoTransition;
}): string {
  return `${row.turn ?? 0}:${row.time}:${row.transition.kind}:${row.transition.content}`;
}

/**
 * Merges both sources, live overriding stored on the same key, ordered by
 * time. `Array#sort` is stable since ES2019, so rows sharing a timestamp keep
 * the order they were folded in.
 */
export function mergeTodoChanges(
  stored: readonly TodoTransitionRecord[] | undefined,
  live: readonly TodoTransitionRecord[],
): TodoFeedRow[] {
  const byKey = new Map<string, TodoFeedRow>();
  const add = (record: TodoTransitionRecord): void => {
    const key = todoTransitionKey(record);
    byKey.set(key, { key, transition: record.transition, time: record.time });
  };
  for (const record of stored ?? []) add(record);
  for (const record of live) add(record);
  return [...byKey.values()].sort((a, b) => a.time - b.time);
}

/**
 * Folds a stored transcript plus the live buffer around it.
 *
 * The two overlap: the buffer starts when the channel opened, which is
 * normally before the `fetchSessionEvents` snapshot was taken, so it repeats
 * events the stored list already contains. Concatenating them replays old
 * snapshots after newer ones and diffing backwards invents `reopened` /
 * `removed` lines. Cut the buffer at the newest stored event instead — the
 * transcript is time-ordered, so everything at or before that point is
 * already accounted for.
 */
export function foldMergedTodoTransitions(
  stored: readonly TodoEvent[],
  live: readonly TodoEvent[],
): TodoTransitionRecord[] {
  if (stored.length === 0) return foldTodoTransitions(live, null);
  let cutoff = Number.NEGATIVE_INFINITY;
  for (const event of stored) cutoff = Math.max(cutoff, event.time ?? 0);
  return foldTodoTransitions(
    [...stored, ...live.filter((event) => (event.time ?? 0) > cutoff)],
    null,
  );
}
