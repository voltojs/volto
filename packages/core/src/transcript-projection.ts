/**
 * Projects a durable event log back into the `Message[]` a session resume
 * needs. The single source of truth for "what did this conversation look
 * like" — the store performs no shape conversion of its own.
 *
 * Pure: no I/O, no clock, no randomness. Same events in, same messages out.
 *
 * This mirrors two reducer subtleties exactly (see reducer.ts):
 *
 * 1. Parallel tool results flush in `pendingTools` order (the `tool_result`
 *    event's `orderInBatch`), not arrival order — but ONLY when the batch is
 *    completed by a `tool_result`. A batch completed by a denial flushes in
 *    raw arrival order instead (`Object.values(_toolResultBuffer)`,
 *    reducer.ts:678), because the reducer's deny path never reorders by
 *    `pendingTools`.
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
   * event's `orderInBatch`). `undefined` for a denial, which the reducer
   * reconstructs from `approval_decision` rather than a `tool_result` and
   * never places through `pendingTools` ordering — see `flushBatch`.
   */
  order: number | undefined;
}

/**
 * Tracks one in-flight tool batch: the ids it must resolve before it can
 * flush, and what has resolved so far (by both id, for lookup/dedup, and
 * arrival order, for the denial flush path).
 */
interface PendingBatch {
  expected: Set<string>;
  resolvedOrder: string[];
  resolved: Map<string, ResolvedEntry>;
}

function startBatch(ids: readonly string[]): PendingBatch {
  return { expected: new Set(ids), resolvedOrder: [], resolved: new Map() };
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
  if (!batch.resolved.has(id)) batch.resolvedOrder.push(id);
  batch.resolved.set(id, { entry, order });
  return batch.resolved.size === batch.expected.size;
}

/**
 * Flushes a complete batch into `out`, followed by whatever steering queued
 * up while the batch was in flight (the reducer's
 * `[...orderedResultMsgs, ...queuedUserInputs]`, reducer.ts:562-566).
 *
 * `mode: "ordered"` mirrors the tool_result completion path: sort by
 * `orderInBatch`, dropping any entry without a valid (>= 0) order — an
 * unmatched id (reducer.ts:518 `matchingIndex === -1`) is never in
 * `pendingTools` at flush time, so `pendingTools.map(...)` never picks it up
 * either.
 *
 * `mode: "arrival"` mirrors the denial completion path (reducer.ts:678):
 * `Object.values(buffer)` with no reordering and no filtering — every
 * resolved entry ships, in the order it resolved.
 */
function flushBatch(
  batch: PendingBatch,
  mode: "ordered" | "arrival",
  steering: readonly ProjectedMessage[],
  out: ProjectedMessage[],
): void {
  const entries = batch.resolvedOrder.map((id) => {
    const resolved = batch.resolved.get(id);
    if (!resolved) throw new Error(`transcript-projection: missing resolved entry for "${id}"`);
    return resolved;
  });

  const ordered =
    mode === "ordered"
      ? entries
          .filter((r) => r.order !== undefined && r.order >= 0)
          .sort((a, b) => a.order! - b.order!)
      : entries;

  for (const r of ordered) out.push(r.entry);
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
          flushBatch(batch, "ordered", steering, messages);
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
        // "allow" puts the tool back into pendingTools to execute normally —
        // its eventual tool_result event resolves the batch. Only "deny"
        // synthesizes a result here, mirroring reducer.ts:650-660.
        if (data.decision !== "deny") break;

        const name = toolNamesById.get(data.callId) ?? "tool";
        const block: ToolResultContent = {
          type: "tool_result",
          toolUseId: data.callId,
          content: `Tool "${name}" was denied by the user.`,
          isError: true,
        };
        const entry: ProjectedMessage = { message: { role: "tool", content: [block] }, time: event.time };

        // No orderInBatch: the reducer's deny path never reorders by
        // pendingTools (reducer.ts:678), so this entry carries no order.
        if (batch && resolveInBatch(batch, data.callId, entry, undefined)) {
          flushBatch(batch, "arrival", steering, messages);
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
