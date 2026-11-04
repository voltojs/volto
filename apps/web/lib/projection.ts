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
  ConversationBlock,
  ConversationMessage,
  ConversationView,
  TranscriptDelta,
  TranscriptEvent,
  TranscriptEventInput,
  TrajectoryRow,
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

// ---------------------------------------------------------------------------
// Steering queue fold (spec 2026-11-04 §4.6)
// ---------------------------------------------------------------------------
//
// The web renders a message queued mid-turn at its SEND position with a
// `queued` badge, deliberately differing from core's record fold, whose
// semantics are the delivery point — the semantics the GET view, the
// trajectory, and the server-side session detail keep. One event must not be
// rendered twice, so the id-carrying steering events are folded here and
// kept out of the record fold.

/**
 * Steering events the web's own queue fold owns. A legacy `steering_queued`
 * without an `id` has no stable identity to fold by; it keeps core's
 * pre-id placement instead of disappearing from the feed.
 */
function ownedBySteeringFold(event: TranscriptEventInput): boolean {
  switch (event.type) {
    case 'steering_queued':
      return typeof (event.data as { id?: unknown }).id === 'string';
    case 'steering_edited':
    case 'steering_removed':
    case 'steering_delivered':
      // These only ever target stamped ids, i.e. inputs core never saw
      // (their queued counterparts are filtered above), so core treats them
      // as no-ops either way.
      return true;
    default:
      return false;
  }
}

/** Content shape of a `steering_queued` event (string or content blocks). */
type SteeringContent = TranscriptEventInput<'steering_queued'>['data']['content'];

/** One queued user bubble, folded from the steering events. */
interface QueuedEntry {
  /** Stamped at enqueue time — the entry's identity and React key. */
  id: string;
  content: SteeringContent;
  /** The `steering_queued` event's clock time — the send-position anchor. */
  time: number;
  queued: boolean;
}

/**
 * Folds the steering queue in event order (FIFO): `steering_queued` creates
 * the entry, `steering_edited` rewrites its content in place,
 * `steering_removed` drops it entirely, and `steering_delivered` flips
 * `queued` to false without moving it. Pure — folding the live-accumulated
 * buffer and re-folding the same stored log produce the same entries.
 */
function foldSteeringQueue(events: readonly TranscriptEventInput[]): QueuedEntry[] {
  const byId = new Map<string, QueuedEntry>();
  const sendOrder: string[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'steering_queued': {
        const data = event.data as { id?: unknown; content: SteeringContent };
        if (typeof data.id !== 'string') break;
        // Idempotent: a repeated queue event keeps the first send position.
        if (byId.has(data.id)) break;
        byId.set(data.id, {
          id: data.id,
          content: data.content,
          time: event.time,
          queued: true,
        });
        sendOrder.push(data.id);
        break;
      }
      case 'steering_edited': {
        const data = event.data as { id: string; content: SteeringContent };
        const entry = byId.get(data.id);
        if (entry) entry.content = data.content;
        break;
      }
      case 'steering_removed': {
        const data = event.data as { id: string };
        byId.delete(data.id);
        break;
      }
      case 'steering_delivered': {
        const data = event.data as { ids: string[] };
        for (const id of data.ids) {
          const entry = byId.get(id);
          if (entry) entry.queued = false;
        }
        break;
      }
    }
  }
  return sendOrder.flatMap((id) => {
    const entry = byId.get(id);
    return entry ? [entry] : [];
  });
}

/** Mirrors core's private `textOf`: the copy-to-clipboard text surface. */
function contentText(content: SteeringContent): string {
  if (typeof content === 'string') return content;
  let text = '';
  for (const block of content) {
    if (block.type === 'text' || block.type === 'structured') text += block.text;
  }
  return text;
}

/** Mirrors core's private `userConversationBlocks` for a queued input. */
function queuedBlocks(content: SteeringContent): ConversationBlock[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  const blocks: ConversationBlock[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text) blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'structured') {
      // No dedicated chat shape; the required text projection is the exit.
      if (block.text) blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      blocks.push({
        type: 'image',
        attachmentId: block.source.id,
        mediaType: block.source.mediaType,
        ...(block.width !== undefined ? { width: block.width } : {}),
        ...(block.height !== undefined ? { height: block.height } : {}),
      });
    }
  }
  return blocks;
}

function toFeedMessage(entry: QueuedEntry): FeedMessage {
  return {
    id: entry.id,
    role: 'user',
    blocks: queuedBlocks(entry.content),
    content: contentText(entry.content),
    timestamp: entry.time,
    queued: entry.queued,
  };
}

/**
 * Places folded entries at their send positions: after every message that
 * was already folded when the message was queued, before everything that
 * arrived later — the feed tail at send time, stable as the turn continues.
 * Equal timestamps keep the already-folded message first (a sub-millisecond
 * tie the event array order alone cannot break here).
 */
function insertQueuedMessages(
  messages: readonly ConversationMessage[],
  queued: readonly QueuedEntry[],
): FeedMessage[] {
  const merged: FeedMessage[] = [];
  let next = 0;
  for (const message of messages) {
    while (next < queued.length && queued[next]!.time < message.timestamp) {
      merged.push(toFeedMessage(queued[next]!));
      next += 1;
    }
    merged.push(message);
  }
  while (next < queued.length) {
    merged.push(toFeedMessage(queued[next]!));
    next += 1;
  }
  return merged;
}

/**
 * Builds the chat feed from durable events plus whatever is still streaming.
 *
 * `prev` lets closed turns keep their object identity across rebuilds, so a
 * memoising row component re-renders only the turn in flight.
 *
 * Steering queue events are excluded from the record fold and folded into
 * the message list here instead (send positions + `queued` badge, spec §4.6).
 */
export function projectConversation(
  events: readonly TranscriptEventInput[],
  deltas: readonly TranscriptDelta[],
  prev?: readonly TurnRecord[],
  t: (key: string) => string = (key) => key,
): ProjectedConversation {
  const recordEvents = events.filter((event) => !ownedBySteeringFold(event));
  let records = buildTurnRecords(asStored(recordEvents), prev);
  for (const delta of deltas) records = applyPartial(records, delta);
  const view = toConversationView(records);
  return {
    view: { messages: insertQueuedMessages(view.messages, foldSteeringQueue(events)) },
    records,
  };
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

/**
 * A neutral status row in the conversation (a cancelled turn, a model-tier
 * fallback). `key` is the React key; `time` is the event's epoch time.
 */
export interface ChatNotice {
  key: string;
  text: string;
  time: number;
}

/** One rendered row of the conversation: a chat bubble, an error, or a notice. */
export type ChatEntry =
  | { kind: 'message'; message: FeedMessage }
  | { kind: 'error'; key: string; text: string; time: number }
  | ({ kind: 'notice' } & ChatNotice);

/**
 * A conversation message as the web renders it. A user entry queued
 * mid-turn carries `queued`: true while it waits for delivery, false once a
 * `steering_delivered` named it — the badge state only; the entry never
 * moves (spec §4.6). Absent on every message that never went through the
 * queue.
 */
export type FeedMessage = ConversationMessage & { queued?: boolean };

/**
 * Composes the feed a UI renders from a merged message list plus the live
 * turn records the projection produced, with session-level notices (e.g. a
 * model-tier fallback) trailing the whole feed.
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
  notices: readonly ChatNotice[] = [],
  t: (key: string) => string = (key) => key,
): ChatEntry[] {
  const stepErrorText = new Map<string, string>();
  for (const turn of records) {
    for (const step of turn.steps) {
      if (!step.error || step.assistant !== undefined) continue;
      stepErrorText.set(
        `${turn.turn}:${step.step}`,
        step.error.message || t('projection.executionFailed'),
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

  const composed = withCancelNotices(entries, records, t);

  // Session-level notices (model-tier fallback) trail the whole feed. They
  // deliberately differ from the cancel notice above: a cancelled turn has
  // no message of its own, so its notice is spliced into the turn's own
  // entries to stay with what it describes (appending would float it below
  // every later turn), while a tier degradation is a session-level advisory
  // about how a sub-agent was dispatched (D5 emits it parent-level,
  // un-tagged) — not a property of any turn's messages. Turn-anchoring it
  // would invent an association the event does not claim, so it renders
  // once, trailing the feed.
  return [
    ...composed,
    ...notices.map((notice) => ({ kind: 'notice' as const, ...notice })),
  ];
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
  t: (key: string) => string = (key) => key,
): ChatEntry[] {
  const cancelled = records.filter((t) => t.reason === 'cancelled');
  if (cancelled.length === 0) return entries as ChatEntry[];

  const noticeFor = (turn: TurnRecord): ChatEntry => ({
    kind: 'notice',
    key: noticeKey(turn),
    text: t('projection.interrupted'),
    time: turn.endedAt ?? turn.startedAt,
  });
  // A turn can be cancelled more than once (stop, continue, stop again): the
  // same turn number then repeats, so the notice key carries its own counter.
  const seenTurns = new Map<number, number>();
  const noticeKey = (turn: TurnRecord): string => {
    const seen = seenTurns.get(turn.turn) ?? 0;
    seenTurns.set(turn.turn, seen + 1);
    return `${turn.turn}:cancelled:${seen}`;
  };
  const pending = new Map(cancelled.map((t) => [t.turn, t]));

  const result: ChatEntry[] = [];
  let openTurn: number | null = null;
  for (const entry of entries) {
    const parsed = entryTurn(entry);
    // A queued bubble's id is its stamped steering id — no `${turn}:` prefix.
    // It belongs to the turn it was queued in, so an unparseable id must not
    // read as a turn boundary (that would splice the cancel notice ahead of
    // the rest of its own turn); the open turn carries forward instead.
    const turn: number = Number.isNaN(parsed) ? openTurn ?? parsed : parsed;
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
