/**
 * Context usage projection for one session: the server's fold snapshot (if
 * any) seeds the state, and the live SSE event buffer folds on top of it.
 * `live=false` (the buffer belongs to another session) renders the seed as-is.
 */

import {
  contextUsageView,
  createCharTokenizer,
  emptyContextUsageFold,
  foldContextUsageEvent,
  type ContextUsageFold,
  type ContextUsageView,
  type TranscriptEventInput,
} from '@volto/sdk/sse';

// 同 chars/4 启发式（core testing/char-tokenizer 的公开导出）；与
// runtimes/*/tokenizer.ts 一致，整合是后续事项。
const tokenizer = createCharTokenizer();

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
