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
  ConversationMessage,
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

export interface ProjectedConversation {
  view: ConversationView;
  /** Pass back as `prev` on the next call to keep closed turns' identity. */
  records: TurnRecord[];
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
): ProjectedConversation {
  let records = buildTurnRecords(asStored(events), prev);
  for (const delta of deltas) records = applyPartial(records, delta);
  return { view: toConversationView(records), records };
}

// ---------------------------------------------------------------------------
// Client-side feed composition
// ---------------------------------------------------------------------------
//
// A session's rendered feed is its persisted history (`session.messages`,
// projected server-side when recovered or saved client-side while active)
// plus the live projection of whatever the SSE channel has streamed since the
// session was opened. The two are merged by stable message id — the live list
// supersedes the snapshot for the same turn position — so switching back to a
// recovered session and continuing it shows one continuous conversation.

/**
 * Merges a session's persisted history with the live projection. The live
 * side wins on id collisions, and (for an active session whose snapshot
 * lags a debounce behind) is a strict superset, so the result equals the
 * live feed once a turn is underway.
 */
export function mergeStoredAndLive(
  stored: readonly ConversationMessage[],
  live: readonly ConversationMessage[],
): ConversationMessage[] {
  if (stored.length === 0) return live as ConversationMessage[];
  if (live.length === 0) return stored as ConversationMessage[];
  const liveIds = new Set(live.map((m) => m.id));
  return [
    ...stored.filter((m) => !liveIds.has(m.id)),
    ...(live as ConversationMessage[]),
  ];
}

/** One rendered row of the conversation: a chat bubble or an error notice. */
export type ChatEntry =
  | { kind: 'message'; message: ConversationMessage }
  | { kind: 'error'; key: string; text: string; time: number };

/**
 * Composes the feed a UI renders from a merged message list plus the live
 * turn records the projection produced.
 *
 * Three rules keep the conversation honest around failures:
 * - A step that errored before producing an authoritative `assistant_message`
 *   (`model_error` after `model_call_start`) is terminal: a mid-stream failure
 *   can leave the step's streaming partial alive (the chat-store deltas are
 *   only cleared by `assistant_message`, and the partial is what carries the
 *   already-streamed text). Such a step must stop presenting its message as
 *   streaming — no permanent caret — while keeping the streamed text, and its
 *   error surfaces as a notice right after the text (or in the bubble's place
 *   when nothing streamed at all).
 * - A closed empty assistant bubble with no recorded error has nothing to
 *   show and is dropped rather than rendered blank.
 * - Turn-level errors (local send failures, protocol error events) have no
 *   message of their own — they surface as a trailing error notice rather
 *   than being swallowed. A turn whose step already surfaced its error skips
 *   the duplicate notice.
 */
export function composeChatEntries(
  messages: readonly ConversationMessage[],
  records: readonly TurnRecord[],
): ChatEntry[] {
  const stepErrorText = new Map<string, string>();
  for (const turn of records) {
    for (const step of turn.steps) {
      if (!step.error || step.assistant !== undefined) continue;
      stepErrorText.set(
        `${turn.turn}:${step.step}`,
        step.error.message || '执行失败',
      );
    }
  }

  const entries: ChatEntry[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const errorText = stepErrorText.get(message.id);
      if (errorText !== undefined) {
        // A step that errored before an authoritative assistant_message is
        // terminal: nothing more will stream into it, so it must not keep
        // blinking as if still in flight. The streamed text stays (the deltas
        // are deliberately left in the chat-store buffer, so it does not
        // vanish), but the message is no longer presented as streaming, and
        // the failure surfaces as an error notice in the bubble's place.
        const hasContent = message.blocks.length > 0 || message.content !== '';
        if (hasContent) {
          entries.push({
            kind: 'message',
            message: { ...message, isStreaming: false },
          });
        }
        entries.push({
          kind: 'error',
          key: `${message.id}:error`,
          text: errorText,
          time: message.timestamp,
        });
        continue;
      }
      // Closed empty assistant bubbles with no recorded error have nothing to
      // show — the bubble would be blank, so it is simply not rendered.
      const emptyClosed =
        message.blocks.length === 0 &&
        message.content === '' &&
        message.isStreaming !== true;
      if (emptyClosed) continue;
    }
    entries.push({ kind: 'message', message });
  }

  // Trailing notices for turn-level errors the message list cannot carry.
  for (const turn of records) {
    if (!turn.error) continue;
    if (turn.steps.some((s) => s.error !== undefined)) continue;
    entries.push({
      kind: 'error',
      key: `${turn.turn}:error`,
      text: turn.error,
      time: turn.startedAt,
    });
  }

  return entries;
}
