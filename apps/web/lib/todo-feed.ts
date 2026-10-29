/**
 * Merge of stored and live todo transitions into the rows the chat feed draws.
 *
 * Two sources exist for the same history: the server folds it from the durable
 * log (`GET /sessions/:id` → `todoChanges`, so a reload keeps it), and the live
 * SSE buffer folds it as a turn runs. They overlap whenever an event landed on
 * both sides, and there is no `seq` on the client — SSE frames carry
 * `TranscriptEventInput` only — so identity comes from the event itself:
 * `turn:time:kind:content`. Live wins on a collision, mirroring how the feed
 * merges messages by id.
 */

import type { TodoTransition, TodoTransitionRecord } from '@volto/sdk/sse';

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
  return `${row.turn ?? ''}:${row.time}:${row.transition.kind}:${row.transition.content}`;
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
