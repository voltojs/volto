/**
 * Context usage projection for one session: the server's fold snapshot (if
 * any) seeds the state, and the live SSE event buffer folds on top of it.
 * `live=false` (the buffer belongs to another session) renders the seed as-is.
 */

import {
  contextUsageView,
  createHeuristicTokenizer,
  emptyContextUsageFold,
  foldContextUsageEvent,
  type ContextUsageFold,
  type ContextUsageView,
  type TranscriptEventInput,
} from '@volto/sdk/sse';

// Same source as the server's node tokenizer — both delegate to core's
// heuristic, so a fold seeded server-side continues client-side unchanged.
const tokenizer = createHeuristicTokenizer();

export function projectContextUsage(
  seed: ContextUsageFold | null | undefined,
  events: readonly TranscriptEventInput[],
  live: boolean,
): { fold: ContextUsageFold; view: ContextUsageView | null } {
  const base = seed ?? emptyContextUsageFold();
  if (!live) return { fold: base, view: contextUsageView(base, tokenizer) };
  let fold = base;
  for (const event of events) fold = foldContextUsageEvent(fold, event, tokenizer);
  return { fold, view: contextUsageView(fold, tokenizer) };
}
