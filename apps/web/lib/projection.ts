/**
 * Thin wrapper over the SDK's re-exported projections.
 *
 * Imports from `@volto/sdk/sse` rather than the package root: the root pulls
 * in Node-only packages (@volto/runtime-node, @volto/tools-shell) that must
 * never reach the browser bundle.
 */

import {
  buildTurnRecords,
  applyPartial,
  toConversationView,
} from '@volto/sdk/sse';
import type {
  ConversationView,
  TranscriptDelta,
  TranscriptEvent,
  TranscriptEventInput,
  TurnRecord,
} from '@volto/sdk/sse';

/** Events arriving over SSE carry no seq; the projection never reads one. */
function asStored(events: readonly TranscriptEventInput[]): TranscriptEvent[] {
  return events.map((e, i) => ({ ...e, seq: i }) as TranscriptEvent);
}

/**
 * Builds the chat feed from durable events plus whatever is still streaming.
 *
 * `prev` lets closed turns keep their object identity across rebuilds, so a
 * memoising row component re-renders only the turn in flight.
 */
export function projectConversation(
  events: readonly TranscriptEventInput[],
  deltas: readonly TranscriptDelta[],
  prev?: readonly TurnRecord[],
): ConversationView {
  let records = buildTurnRecords(asStored(events), prev);
  for (const delta of deltas) records = applyPartial(records, delta);
  return toConversationView(records);
}
