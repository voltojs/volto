/**
 * Server-side context-usage snapshot: folds a session's durable transcript
 * into the numbers-only form the web app seeds its live folding from. Pure
 * core functions + an injected node tokenizer. The store read is the only I/O
 * here.
 *
 * Folding straight into the snapshot (rather than folding then converting)
 * keeps the header's full text — every system layer plus every tool schema —
 * out of the response entirely.
 */

import { emptyContextUsageSnapshot, foldSnapshotEvent } from "@voltojs/core";
import type { ContextUsageSnapshot } from "@voltojs/core";
import { createNodeTokenizer } from "@voltojs/runtime-node";
import type { JsonlSessionStore } from "@voltojs/store-jsonl";

const tokenizer = createNodeTokenizer();

/** Folds one session's stored events. Never throws for an unknown session — returns the empty snapshot. */
export async function readContextUsageSnapshot(
  store: JsonlSessionStore,
  sessionId: string,
): Promise<ContextUsageSnapshot> {
  const events = await store.readEvents(sessionId);
  let snapshot = emptyContextUsageSnapshot();
  for (const event of events) snapshot = foldSnapshotEvent(snapshot, event, tokenizer);
  return snapshot;
}
