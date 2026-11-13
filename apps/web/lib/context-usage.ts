/**
 * Context usage projection for one session: the server's numbers-only
 * snapshot seeds the state, and the live SSE event buffer folds on top of it.
 * `live=false` (the buffer belongs to another session) renders the seed as-is.
 */

import {
  createHeuristicTokenizer,
  emptyContextUsageSnapshot,
  foldSnapshotEvent,
  snapshotView,
  type ContextUsageSnapshot,
  type ContextUsageView,
  type TranscriptEventInput,
} from '@voltojs/sdk/sse';

// Same source as the server's node tokenizer — both delegate to core's
// heuristic, so a snapshot made server-side continues client-side unchanged.
const tokenizer = createHeuristicTokenizer();

export function projectContextUsage(
  seed: ContextUsageSnapshot | null | undefined,
  events: readonly TranscriptEventInput[],
  live: boolean,
): { snapshot: ContextUsageSnapshot; view: ContextUsageView | null } {
  const base = seed ?? emptyContextUsageSnapshot();
  if (!live) return { snapshot: base, view: snapshotView(base) };
  let snapshot = base;
  for (const event of events) snapshot = foldSnapshotEvent(snapshot, event, tokenizer);
  return { snapshot, view: snapshotView(snapshot) };
}
