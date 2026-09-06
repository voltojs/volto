/**
 * Server-side context-usage snapshot: folds a session's durable transcript
 * into the serializable fold state the web app seeds its live folding from.
 * Pure core functions + an injected node tokenizer. The fold read is a second
 * full read of the same transcript file the caller reads for projection —
 * that store read is the only I/O here.
 */

import { emptyContextUsageFold, foldContextUsageEvent } from "@volto/core";
import type { ContextUsageFold } from "@volto/core";
import { createNodeTokenizer } from "@volto/runtime-node";
import type { JsonlSessionStore } from "@volto/store-jsonl";

const tokenizer = createNodeTokenizer();

/** Folds one session's stored events. Never throws for an unknown session — returns the empty fold. */
export async function readContextUsageFold(
  store: JsonlSessionStore,
  sessionId: string,
): Promise<ContextUsageFold> {
  const events = await store.readEvents(sessionId);
  let fold = emptyContextUsageFold();
  for (const event of events) fold = foldContextUsageEvent(fold, event, tokenizer);
  return fold;
}
