/**
 * Projects a durable event log back into the `Message[]` a session resume
 * needs. The single source of truth for "what did this conversation look
 * like" — the store performs no shape conversion of its own.
 *
 * Pure: no I/O, no clock, no randomness. Same events in, same messages out.
 *
 * This mirrors two reducer subtleties exactly (see reducer.ts):
 *
 * 1. A batch flushes in `pendingTools` order, not arrival order, whichever
 *    path completes it. The projection tracks a `roster` mirroring
 *    `pendingTools`: it starts as the assistant message's `tool_use` ids, and
 *    an approval moves its tool to the end (the reducer pulls the tool out on
 *    `request_approval` and appends it back on the decision, for both allow
 *    and deny). `orderInBatch` is therefore NOT a sort key — an approval can
 *    leave two entries carrying the same value — only a signal that a result
 *    the reducer could not have flushed (`-1`) must be dropped.
 * 2. The steering queue (`queuedUserInputs`) is turn-scoped: it flushes at
 *    exactly one point — the next tool batch completing — and lands after
 *    that batch's tool results. If the turn ends before any batch completes,
 *    `resetTurnForNextInput` (reducer.ts:123) discards it silently, and the
 *    projection must too: an unflushed queue is DROPPED, never appended at
 *    end-of-log or at end-of-turn.
 *
 * A batch that never fully resolves (every `tool_use` id in the triggering
 * assistant message accounted for) is discarded whole, matching the buffer
 * clear on cancel (reducer.ts:610-615) — a partial flush never happens in the
 * reducer, so the projection must never invent one either.
 */

import type { Message, ToolResultContent, ToolUseContent } from "./state.js";
import type { TranscriptEvent, TranscriptEventMap } from "./ports.js";

/** A projected message paired with the time of the event that produced it. */
export interface ProjectedMessage {
  message: Message;
  time: number;
}

/** One id's resolution within a pending tool batch. */
interface ResolvedEntry {
  entry: ProjectedMessage;
  /**
   * Position within `pendingTools` at the moment this id resolved (the
   * event's `orderInBatch`), or `undefined` for a denial — which the reducer
   * synthesizes from `approval_decision` rather than from a `tool_result`.
   *
   * Only its sign is read, to drop a result the reducer could never have
   * flushed (`-1` = the id was not in `pendingTools`). Placement comes from
   * `roster`, not from this number: an approval reshuffles `pendingTools`, so
   * two entries can legitimately carry the same `orderInBatch`.
   */
  order: number | undefined;
}

/**
 * Tracks one in-flight tool batch.
 *
 * `roster` mirrors the reducer's `pendingTools` for this batch, because
 * `pendingTools` is what the reducer flushes in. It starts as the assistant
 * message's `tool_use` ids and is re-ordered by approvals exactly as the
 * reducer re-orders it (see the `approval_decision` case below).
 */
interface PendingBatch {
  expected: Set<string>;
  roster: string[];
  resolved: Map<string, ResolvedEntry>;
}

function startBatch(ids: readonly string[]): PendingBatch {
  return { expected: new Set(ids), roster: [...ids], resolved: new Map() };
}

/**
 * Mirrors what an approval does to `pendingTools`: `request_approval` pulls
 * the tool out (reducer.ts:594) and the decision puts it back at the end —
 * the allow branch to be executed, the deny branch already resolved. The net
 * effect either way is "move this id to the end of the roster", which is
 * derivable from `approval_decision` alone; `approval_asked` is not needed
 * and, unlike the decision, is not guaranteed to be in the log.
 */
function moveToRosterEnd(batch: PendingBatch, id: string): void {
  const at = batch.roster.indexOf(id);
  if (at < 0) return;
  batch.roster.splice(at, 1);
  batch.roster.push(id);
}

/**
 * Records one id's resolution in the batch (overwriting on a duplicate
 * `callId`, mirroring the reducer's id-keyed buffer keeping only the last —
 * reducer.ts:513). Returns true once every expected id has resolved, meaning
 * the batch is ready to flush.
 *
 * An id outside `expected` (a stray or already-resolved-elsewhere result) is
 * silently ignored, exactly as the reducer's buffer entry for it is simply
 * never read once it falls out of `pendingTools`.
 */
function resolveInBatch(batch: PendingBatch, id: string, entry: ProjectedMessage, order: number | undefined): boolean {
  if (!batch.expected.has(id)) return false;
  batch.resolved.set(id, { entry, order });
  return batch.resolved.size === batch.expected.size;
}

/**
 * Flushes a complete batch into `out`, followed by whatever steering queued
 * up while the batch was in flight (the reducer's
 * `[...orderedResultMsgs, ...queuedUserInputs]`, reducer.ts:562-566).
 *
 * Order is `roster` order, mirroring both of the reducer's completion paths —
 * they now agree, each mapping over `pendingTools`.
 *
 * An entry whose `order` is negative is dropped: `matchingIndex === -1`
 * (reducer.ts:518) means the id was not in `pendingTools` when the result
 * arrived, so `pendingTools.map(...)` could never have picked it up either.
 * A denial carries no `order` at all and always ships — the reducer keeps it
 * on the roster precisely so that it does.
 */
function flushBatch(
  batch: PendingBatch,
  steering: readonly ProjectedMessage[],
  out: ProjectedMessage[],
): void {
  for (const id of batch.roster) {
    const resolved = batch.resolved.get(id);
    if (!resolved) continue;
    if (resolved.order !== undefined && resolved.order < 0) continue;
    out.push(resolved.entry);
  }
  for (const s of steering) out.push(s);
}

/**
 * Rebuilds conversation history from a session's event log, keeping each
 * message's originating timestamp alongside it.
 *
 * The system prompt and any seeded initial messages are NOT included — the
 * host re-injects those when it rebuilds the agent, matching what the v1
 * `chatStorePersistedCount` offset already excluded.
 */
export function projectMessageEntries(events: readonly TranscriptEvent[]): ProjectedMessage[] {
  const messages: ProjectedMessage[] = [];

  /** The tool batch currently being collected, if any. */
  let batch: PendingBatch | undefined;
  /** Steering messages queued since the last batch flush (turn-scoped). */
  let steering: ProjectedMessage[] = [];
  /** callId -> tool name, from `assistant_message` tool_use blocks and `approval_asked`. */
  const toolNamesById = new Map<string, string>();

  for (const event of events) {
    switch (event.type) {
      case "user_message": {
        // A new turn starts. Anything still unresolved from the previous
        // turn (an incomplete batch, unflushed steering) is discarded here,
        // exactly as resetTurnForNextInput (reducer.ts:113) clears
        // pendingTools / _toolResultBuffer / queuedUserInputs before the
        // next user_message is admitted.
        batch = undefined;
        steering = [];

        const data = event.data as TranscriptEventMap["user_message"];
        messages.push({ message: { role: "user", content: data.content }, time: event.time });
        break;
      }

      case "assistant_message": {
        const data = event.data as TranscriptEventMap["assistant_message"];
        messages.push({
          message: {
            role: "assistant",
            content: data.content,
            ...(data.stopReason !== undefined ? { stopReason: data.stopReason } : {}),
          },
          time: event.time,
        });

        const toolUseBlocks = data.content.filter((c): c is ToolUseContent => c.type === "tool_use");
        for (const b of toolUseBlocks) toolNamesById.set(b.id, b.name);

        // A tool_use stop starts a fresh batch, replacing (i.e. discarding)
        // whatever batch was left over — a well-formed log never has one at
        // this point, but a stray leftover must not leak into the new batch.
        batch = data.stopReason === "tool_use" && toolUseBlocks.length > 0 ? startBatch(toolUseBlocks.map((b) => b.id)) : undefined;
        break;
      }

      case "tool_result": {
        const data = event.data as TranscriptEventMap["tool_result"];
        const block: ToolResultContent = {
          type: "tool_result",
          toolUseId: data.callId,
          content: data.content,
          isError: data.isError,
        };
        const entry: ProjectedMessage = { message: { role: "tool", content: [block] }, time: event.time };

        if (batch && resolveInBatch(batch, data.callId, entry, data.orderInBatch)) {
          flushBatch(batch, steering, messages);
          batch = undefined;
          steering = [];
        }
        break;
      }

      case "approval_asked": {
        const data = event.data as TranscriptEventMap["approval_asked"];
        toolNamesById.set(data.callId, data.name);
        break;
      }

      case "approval_decision": {
        const data = event.data as TranscriptEventMap["approval_decision"];
        // Either decision moves the tool to the end of pendingTools, so the
        // roster has to follow suit before anything flushes.
        if (batch) moveToRosterEnd(batch, data.callId);

        // "allow" puts the tool back to execute normally — its eventual
        // tool_result event resolves the batch. Only "deny" synthesizes a
        // result here, mirroring reducer.ts:650-660.
        if (data.decision !== "deny") break;

        const name = toolNamesById.get(data.callId) ?? "tool";
        const block: ToolResultContent = {
          type: "tool_result",
          toolUseId: data.callId,
          content: `Tool "${name}" was denied by the user.`,
          isError: true,
        };
        const entry: ProjectedMessage = { message: { role: "tool", content: [block] }, time: event.time };

        // No orderInBatch: a denial has no tool_result event to carry one.
        // Its position comes from the roster, restored above.
        if (batch && resolveInBatch(batch, data.callId, entry, undefined)) {
          flushBatch(batch, steering, messages);
          batch = undefined;
          steering = [];
        }
        break;
      }

      case "steering_queued": {
        const data = event.data as TranscriptEventMap["steering_queued"];
        steering.push({ message: { role: "user", content: data.content }, time: event.time });
        break;
      }

      default:
        // Every other event type is log-only: it records what happened but
        // does not itself become a message the model sees. `compaction` in
        // particular is NOT a surface replace — the Runner's applyCompaction()
        // only rewrites the outgoing ModelRequest, never `state.messages`.
        break;
    }
  }

  // No trailing flush: an incomplete batch or an unflushed steering queue at
  // end-of-log mirrors what the reducer does on cancel / an end_turn with a
  // non-empty queuedUserInputs — both are silently dropped, never written to
  // `state.messages`. Flushing here would resurrect exactly that content.
  return messages;
}

/**
 * The messages alone — the shape agent rebuild's `initialMessages` seeding
 * needs. A thin projection of `projectMessageEntries` so the ordering rules
 * above exist in exactly one place.
 */
export function projectMessages(events: readonly TranscriptEvent[]): Message[] {
  return projectMessageEntries(events).map((entry) => entry.message);
}
