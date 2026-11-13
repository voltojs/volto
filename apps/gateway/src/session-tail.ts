/**
 * The slice of a transcript that belongs to a turn still in flight: every
 * event after the last `turn_end`. A client that reconnects mid-turn (a page
 * reload, a dropped SSE channel) replays this tail to rebuild the running
 * turn — the generating indicator and the tool batch a later `tool_result`
 * has to resolve.
 *
 * An empty array means the log ends on a settled turn. A log that never
 * recorded a `turn_end` (a crash) yields every event; callers must combine
 * this with the registry's live `running` flag, never treat the tail alone as
 * proof that a turn is running.
 */
import type { TranscriptEvent } from "@voltojs/core";

export function unfinishedTurnTail(
  events: readonly TranscriptEvent[],
): TranscriptEvent[] {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.type === "turn_end") return events.slice(i + 1);
  }
  return events.slice();
}
