/**
 * Node-side read facade over a transcript store.
 *
 * Deliberately thin: read events, then hand them to the pure projections in
 * `@volto/core`. No shape conversion happens here, so a different host can
 * call the same projections without reimplementing anything.
 */

import { buildTurnRecords, toConversationView, toTrajectoryView } from "@volto/core";
import type { ConversationView, TrajectoryView, TranscriptReader } from "@volto/core";

/** Reads a session's chat feed. Rejects if the reader rejects. */
export async function readConversation(
  reader: TranscriptReader,
  sessionId: string,
): Promise<ConversationView> {
  const events = await reader.readEvents(sessionId);
  return toConversationView(buildTurnRecords(events));
}

/** Reads a session's audit ledger. Rejects if the reader rejects. */
export async function readTrajectory(
  reader: TranscriptReader,
  sessionId: string,
): Promise<TrajectoryView> {
  const events = await reader.readEvents(sessionId);
  return toTrajectoryView(buildTurnRecords(events), events);
}
