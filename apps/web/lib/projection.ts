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
  toTrajectoryView,
} from '@volto/sdk/sse';
import type {
  ConversationMessage,
  ConversationView,
  TodoTransition,
  TranscriptDelta,
  TranscriptEvent,
  TranscriptEventInput,
  TrajectoryRow,
  TurnRecord,
} from '@volto/sdk/sse';
import type { TodoFeedRow } from './todo-feed';

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
// projected server-side when recovered, or flushed into the store client-side
// at the moment the session is switched away from) plus the live projection
// of whatever the SSE channel has streamed since the session was opened. The
// two are merged by stable message id — the live list supersedes the
// snapshot for the same turn position — so switching back to a recovered
// session and continuing it shows one continuous conversation.

/**
 * Merges a session's persisted history with the live projection. The live
 * side wins on id collisions, and (for the active session, whose stored
 * snapshot is only refreshed on switch-away, not on every delta) is a strict
 * superset, so the result equals the live feed once a turn is underway.
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

/** One rendered row of the conversation: a chat bubble, an error, a notice, or a todo change. */
export type ChatEntry =
  | { kind: 'message'; message: ConversationMessage }
  | { kind: 'error'; key: string; text: string; time: number }
  | { kind: 'notice'; key: string; text: string; time: number }
  /**
   * One todo status change, in the position it happened. `key` starts with the
   * owning turn so `entryTurn` (cancel-notice placement) keeps working.
   */
  | { kind: 'todo'; key: string; transition: TodoTransition; time: number };

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
 * - A closed empty assistant bubble with no recorded error and no round usage
 *   has nothing to show and is dropped rather than rendered blank.
 * - Turn-level errors (local send failures, protocol error events) have no
 *   message of their own — they surface as a trailing error notice rather
 *   than being swallowed. A turn whose step already surfaced its error skips
 *   the duplicate notice.
 */
export function composeChatEntries(
  messages: readonly ConversationMessage[],
  records: readonly TurnRecord[],
  todoRows: readonly TodoFeedRow[] = [],
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
        const hasContent =
          message.blocks.length > 0 ||
          message.content !== '' ||
          message.turnUsage !== undefined;
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
        // The round's usage is attached to this one message, so swallowing the
        // bubble would drop the whole round's chip (spec §6).
        message.turnUsage === undefined &&
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

  return insertTodoRows(withCancelNotices(entries, records), todoRows);
}

/** Sort key of a rendered row: a bubble uses its timestamp, everything else its own. */
function entryTime(entry: ChatEntry): number {
  return entry.kind === 'message' ? entry.message.timestamp : entry.time;
}

/**
 * Splices todo rows into the feed by time.
 *
 * Rows take the position of the event that produced them; on a tie they land
 * after the message, because a change belongs to the step it concluded rather
 * than to the text before it. Empty input is the identity transform.
 */
function insertTodoRows(
  entries: readonly ChatEntry[],
  rows: readonly TodoFeedRow[],
): ChatEntry[] {
  if (rows.length === 0) return entries as ChatEntry[];
  const out: ChatEntry[] = [];
  let cursor = 0;
  for (const row of rows) {
    while (cursor < entries.length && entryTime(entries[cursor]!) <= row.time) {
      out.push(entries[cursor++]!);
    }
    out.push({ kind: 'todo', key: row.key, transition: row.transition, time: row.time });
  }
  while (cursor < entries.length) out.push(entries[cursor++]!);
  return out;
}

/** The turn an entry belongs to; ids and keys are all `${turn}:…`. */
function entryTurn(entry: ChatEntry): number {
  const id = entry.kind === 'message' ? entry.message.id : entry.key;
  return Number(id.split(':')[0]);
}

/**
 * Inserts a neutral "stopped" notice at the end of every turn the user
 * cancelled.
 *
 * The notice is not a failure (so not an `error` row) and it is the only
 * trace such a turn leaves: no `assistant_message` was ever recorded, and
 * `applyPartial` discards the streamed deltas the moment the turn closes —
 * without it the turn would vanish from the feed as if nothing had happened.
 *
 * Placement matters once the conversation continues past the interruption:
 * appending to the end would float the notice below every later turn, so it
 * is spliced in right after the last entry of its own turn instead.
 */
function withCancelNotices(
  entries: readonly ChatEntry[],
  records: readonly TurnRecord[],
): ChatEntry[] {
  const cancelled = records.filter((t) => t.reason === 'cancelled');
  if (cancelled.length === 0) return entries as ChatEntry[];

  const noticeFor = (turn: TurnRecord): ChatEntry => ({
    kind: 'notice',
    key: `${turn.turn}:cancelled`,
    text: '已中断本次生成',
    time: turn.endedAt ?? turn.startedAt,
  });
  const pending = new Map(cancelled.map((t) => [t.turn, t]));

  const result: ChatEntry[] = [];
  let openTurn: number | null = null;
  for (const entry of entries) {
    const turn = entryTurn(entry);
    if (openTurn !== null && turn !== openTurn) {
      const done = pending.get(openTurn);
      if (done) {
        result.push(noticeFor(done));
        pending.delete(openTurn);
      }
    }
    result.push(entry);
    openTurn = turn;
  }

  // Whatever is left belongs to the last turn rendered (or to a turn with no
  // entries of its own at all, e.g. one cancelled before anything streamed).
  for (const turn of cancelled) {
    if (pending.has(turn.turn)) result.push(noticeFor(turn));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Trajectory projection
// ---------------------------------------------------------------------------

export interface ProjectedTrajectory {
  rows: TrajectoryRow[];
  /** 正在流式输出的 assistant 行 id；无进行中 step 时为 null。 */
  streamingRowId: string | null;
}

function findStreamingRowId(records: readonly TurnRecord[]): string | null {
  const turn = records.at(-1);
  if (!turn || turn.endedAt !== undefined) return null;
  const step = turn.steps.at(-1);
  if (!step || step.partial === undefined) return null;
  return `${turn.turn}:${step.step}`;
}

/**
 * 活跃会话的轨迹投影：与 projectConversation 完全同构——同一事件缓冲、
 * 同一 asStored 伪造 seq、同一 buildTurnRecords/applyPartial 管线，只是
 * 出口换成 toTrajectoryView。不传 prev：与 use-conversation 的既有决策一致
 * （设计文档 §五 偏差已入档，core 侧结构水印护住陈旧复用）。
 */
export function projectTrajectory(
  events: readonly TranscriptEventInput[],
  deltas: readonly TranscriptDelta[],
): ProjectedTrajectory {
  const stored = asStored(events);
  let records = buildTurnRecords(stored);
  for (const delta of deltas) records = applyPartial(records, delta);
  return {
    rows: toTrajectoryView(records, stored).rows,
    streamingRowId: findStreamingRowId(records),
  };
}

/**
 * 合流历史行（服务端 trajectory）与实时行（活跃会话投影）。
 * 规则与 mergeStoredAndLive 相同：按稳定 row.id 去重、live 优先
 * （恢复时轮次仍在进行：同一轮的事件既在盘上又在实时流里，live 侧含
 * partial、状态更新），再按 startedAt 排序、重编 1-based index。
 *
 * id 之外还有内容键兜底：context / compaction 行的 id 内嵌事件 seq，
 * 服务端用 store 分配的 seq，客户端从缓冲下标伪造 seq——同一
 * request_header 事件两侧 id 可能不同（首拉竞态下上下文行会成对出现）。
 * 兜底只作用于 id 未撞上的存量行，且要求 startedAt 与 summary 全同才算
 * 同一行；真正不同的行（含同轮多份 header）二者必有差异，不受影响。
 */
function rowContentKey(row: TrajectoryRow): string {
  return `${row.kind}:${row.turn}:${row.step ?? ''}:${row.startedAt}:${row.summary}`;
}

export function mergeStoredAndLiveRows(
  stored: readonly TrajectoryRow[],
  live: readonly TrajectoryRow[],
): TrajectoryRow[] {
  if (live.length === 0) return [...stored];
  const liveIds = new Set(live.map((r) => r.id));
  const liveContentKeys = new Set(live.map(rowContentKey));
  const merged =
    stored.length === 0
      ? [...live]
      : [
          ...stored.filter(
            (r) => !liveIds.has(r.id) && !liveContentKeys.has(rowContentKey(r)),
          ),
          ...live,
        ];
  return merged
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((row, i) => ({ ...row, index: i + 1 }));
}
