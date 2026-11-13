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
 * 2. The steering queue (`queuedUserInputs`) drains at several points —
 *    tool-batch flush, approval flush, end_turn continuation, the idle
 *    pre-flush before a new turn's opening message (D11b), and a
 *    `steering_flush` turn open (D11) — and every drain announces the
 *    drained ids with `steering_delivered`. This fold REALIZES an id-tracked
 *    queued entry at that event: it renders exactly once, at the delivery
 *    point, carrying `steering_edited` content and never anything
 *    `steering_removed`. A cross-turn realization (the idle pre-flush)
 *    anchors at the turn's OPENING — before that turn's `user_message`
 *    entry — because the runner records the opening input before the drain's
 *    effects even though the reducer renders [...olderQueue, newUserMsg].
 *    Entries a log never delivers keep the pre-feature structural behavior
 *    (flushed after the batch's tool results at the next batch completion,
 *    otherwise dropped — D11 keeps the reducer's queue alive for the host
 *    auto-run; this fold never appends an undelivered queue at end-of-log or
 *    end-of-turn). Legacy `steering_queued` events without an id carry no
 *    realization signal and always take that structural path.
 *
 * Termination pairing (D12): a turn that ends while a batch is still in
 * flight no longer leaves it discarded whole. The reducer answers every
 * un-fulfilled `tool_use` on teardown — a synthesized `isError` tool_result,
 * keeping an already-buffered real result where one arrived — and the
 * `turn_end` case below mirrors that synthesis byte for byte (providers
 * reject un-paired `tool_use` outright, so a resumed session must rebuild
 * exactly what the live reducer wrote). Only a log that never reaches
 * `turn_end` (a crash mid-turn) leaves the batch unresolved, and THAT is
 * discarded whole at the next `user_message`, matching
 * `resetTurnForNextInput` clearing `pendingTools` / `_toolResultBuffer`
 * without ever flushing them.
 *
 * Compaction write-back (Task 2): a `compaction` event carrying
 * `replacedIds`/`summaryId` rewrites the projected list the same way the
 * reducer's `compaction_applied` handler rewrites `state.messages` — remove
 * the named messages, insert one user-role summary at the earliest replaced
 * position (user role so the ContextAssembler keeps the static layers ahead
 * of it, preserving the provider prefix cache), and, when the event carries
 * non-empty `preservedImages` (D5 v1.2), the user-role images carrier right
 * after the summary (`${summaryId}-images`, markers verbatim before each
 * image ref). Ids match because the message-producing events carry the
 * reducer's durable `messageId`; legacy events without one project a `proj-N`
 * fallback, so a legacy compaction event (or one whose replacedIds match
 * nothing in the projection) is skipped.
 * `tool_results_pruned` stays log-only: the event omits pruned content by
 * design, so the projection has nothing to rewrite with.
 */

import type { Message, ToolResultContent, ToolUseContent, ContentBlock } from "./state.js";
import { normalizeToolResultContent } from "./state.js";
import type { TranscriptEvent, TranscriptEventMap } from "./ports.js";
import { userDenialMessage } from "./permission-policy.js";
import { interruptionMessageFor } from "./reducer.js";
import { renderImagePreservedMarker } from "./compaction-image-offload.js";

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
 * One id-tracked steering entry awaiting realization (Task 6).
 *
 * `openSeq` records how many `user_message` events had opened a turn when
 * the entry was queued: an entry queued before the current turn's opening
 * message is a CROSS-TURN realization and must anchor at that opening, not
 * at the delivered event's own position (see `steering_delivered` below).
 */
interface QueuedSteering {
  entry: ProjectedMessage;
  openSeq: number;
}

/**
 * Mirrors what an approval does to `pendingTools`: `request_approval` pulls
 * the tool out (reducer.ts) and the decision puts it back at the end — the
 * allow branch to be executed, the deny branch already resolved. The net
 * effect either way is "move this id to the end of the roster", derived from
 * BOTH `approval_asked` and `approval_decision` (idempotent — the second
 * move is a no-op). Moving at ask time matters when the turn dies before a
 * decision ever arrives: the termination pairing flushes the
 * approval-pending call LAST, exactly as the reducer's roster orders it.
 * A legacy log without `approval_asked` still works — the decision alone
 * moves the id before anything flushes.
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
  /**
   * Queued steering awaiting the next batch flush (turn-scoped). This is the
   * LEGACY structural path: it also carries id-tracked entries until their
   * `steering_delivered` realizes them, so a log that never delivers an
   * entry keeps the pre-feature placement.
   */
  let steering: ProjectedMessage[] = [];
  /**
   * Id-tracked queued entries awaiting realization, FIFO per id. Ids are
   * stamped unique in production; a legacy log can hold several unstamped
   * entries under `""`, so each id maps to a FIFO list.
   */
  const queuedById = new Map<string, QueuedSteering[]>();
  /** How many `user_message` events have opened a turn so far. */
  let openSeq = 0;
  /** The projected entry of the current turn's opening `user_message`, if any. */
  let turnOpenEntry: ProjectedMessage | undefined;
  /** Last entry a cross-turn realization anchored at the turn's opening. */
  let openingAnchor: ProjectedMessage | undefined;
  /**
   * Non-anchor messages appended since `turnOpenEntry`. A cross-turn
   * realization anchors at the opening only while the opening is still the
   * tail of what the next model step will see — once other messages landed
   * after it, the reducer's own placement is the drain point.
   */
  let messagesSinceTurnOpen = 0;
  /** callId -> tool name, from `assistant_message` tool_use blocks and `approval_asked`. */
  const toolNamesById = new Map<string, string>();
  /**
   * Synthetic ids for reconstructed messages. Events recorded before the
   * durable-id write-back (and synthetic messages the reducer never emits an
   * id for) still need deterministic identity, so a local counter fills the
   * gap without inventing I/O.
   */
  let projSeq = 0;
  const nextProjId = (): string => `proj-${++projSeq}`;
  /**
   * Prefer the durable message id a transcript event carries (the reducer's
   * stamped `Message.id`), falling back to a synthetic one for legacy logs.
   * Durable ids are what let a later `compaction` event's `replacedIds`
   * match projected messages on a cold rebuild — without them the compaction
   * branch is dead in production (events used to carry no identity).
   */
  const projectMessageId = (durable: string | undefined): string =>
    durable !== undefined && durable !== "" ? durable : nextProjId();

  /** Registers an id-tracked queued entry (FIFO per id). */
  const registerQueued = (id: string, entry: ProjectedMessage): void => {
    const list = queuedById.get(id);
    const item: QueuedSteering = { entry, openSeq };
    if (list) list.push(item);
    else queuedById.set(id, [item]);
  };

  /** The first still-queued entry for an id — the reducer's findIndex. */
  const firstQueued = (id: string): QueuedSteering | undefined => queuedById.get(id)?.[0];

  /** Removes and returns the first still-queued entry for an id. */
  const claimQueued = (id: string): QueuedSteering | undefined => {
    const list = queuedById.get(id);
    const item = list?.shift();
    if (list !== undefined && list.length === 0) queuedById.delete(id);
    return item;
  };

  for (const event of events) {
    switch (event.type) {
      case "user_message": {
        // A new turn starts. Anything still unresolved from the previous
        // turn (an incomplete batch, unflushed steering) is discarded here.
        // The batch half matches resetTurnForNextInput clearing pendingTools
        // / _toolResultBuffer before the next user_message is admitted; the
        // steering half is this projection's drop rule for entries no event
        // ever delivers — the reducer keeps an un-delivered queue alive
        // across turns (D11), this fold never appends it. Id-tracked entries
        // stay in `queuedById` (only the structural buffer is cleared): the
        // D11b idle pre-flush records this opening input BEFORE the drain's
        // `steering_delivered`, so the realization event still follows.
        batch = undefined;
        steering = [];

        const data = event.data as TranscriptEventMap["user_message"];
        const entry: ProjectedMessage = {
          message: { id: projectMessageId(data.messageId), role: "user", content: data.content },
          time: event.time,
        };
        messages.push(entry);
        openSeq += 1;
        turnOpenEntry = entry;
        openingAnchor = undefined;
        messagesSinceTurnOpen = 0;
        break;
      }

      case "assistant_message": {
        const data = event.data as TranscriptEventMap["assistant_message"];
        messages.push({
          message: {
            id: projectMessageId(data.messageId),
            role: "assistant",
            content: data.content,
            ...(data.stopReason !== undefined ? { stopReason: data.stopReason } : {}),
            ...(data.source !== undefined ? { source: data.source } : {}),
            ...(data.modelMeta !== undefined ? { modelMeta: data.modelMeta } : {}),
          },
          time: event.time,
        });
        messagesSinceTurnOpen += 1;

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
          content: normalizeToolResultContent(data.content),
          isError: data.isError,
        };
        const entry: ProjectedMessage = { message: { id: projectMessageId(data.messageId), role: "tool", content: [block] }, time: event.time };

        if (batch && resolveInBatch(batch, data.callId, entry, data.orderInBatch)) {
          flushBatch(batch, steering, messages);
          batch = undefined;
          steering = [];
          messagesSinceTurnOpen += 1;
        }
        break;
      }

      case "approval_asked": {
        const data = event.data as TranscriptEventMap["approval_asked"];
        toolNamesById.set(data.callId, data.name);
        // request_approval pulls the tool out of pendingTools and the
        // decision appends it back at the end — reflect that re-ordering at
        // ask time so a mid-approval termination flushes in the reducer's
        // roster order (see moveToRosterEnd).
        if (batch) moveToRosterEnd(batch, data.callId);
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
          content: normalizeToolResultContent(userDenialMessage(name)),
          isError: true,
        };
        const entry: ProjectedMessage = { message: { id: nextProjId(), role: "tool", content: [block] }, time: event.time };

        // No orderInBatch: a denial has no tool_result event to carry one.
        // Its position comes from the roster, restored above.
        if (batch && resolveInBatch(batch, data.callId, entry, undefined)) {
          flushBatch(batch, steering, messages);
          batch = undefined;
          steering = [];
          messagesSinceTurnOpen += 1;
        }
        break;
      }

      case "steering_queued": {
        const data = event.data as TranscriptEventMap["steering_queued"];
        // A queued entry's id IS its durable Message.id, so the projected
        // entry adopts it (delivery preserves it) — the same identity a
        // later compaction names. Legacy events without one fall back.
        const id: unknown = (data as { id?: unknown }).id;
        const entry: ProjectedMessage = {
          message: {
            id: projectMessageId(typeof id === "string" ? id : undefined),
            role: "user",
            content: data.content,
          },
          time: event.time,
        };
        // Both paths at once: the structural buffer keeps the pre-feature
        // placement for entries no event ever delivers, while the id index
        // lets steering_edited / steering_removed / steering_delivered fold
        // the entry. Legacy events carry no id — buffer only, never throw.
        steering.push(entry);
        if (typeof id === "string") registerQueued(id, entry);
        break;
      }

      case "steering_edited": {
        const data = event.data as TranscriptEventMap["steering_edited"];
        const target = firstQueued(data.id);
        if (target) {
          // Same id, same position, new content — mirrors the reducer's
          // in-place queue edit. The entry object is shared with the
          // structural buffer and `messages`, so wherever the entry has
          // already landed it now renders the edited content too. The
          // queued entry is always a user message.
          const previous = target.entry.message;
          target.entry.message = { id: previous.id, role: "user", content: data.content };
        }
        break;
      }

      case "steering_removed": {
        const data = event.data as TranscriptEventMap["steering_removed"];
        const target = claimQueued(data.id);
        if (target) {
          // Hard delete — no residue anywhere: out of the structural buffer,
          // and (defensively) out of the projected list if some path already
          // rendered it. Delivery wins: an id no longer queued is a no-op.
          const buffered = steering.indexOf(target.entry);
          if (buffered >= 0) steering.splice(buffered, 1);
          const rendered = messages.indexOf(target.entry);
          if (rendered >= 0) messages.splice(rendered, 1);
        }
        break;
      }

      case "steering_delivered": {
        const data = event.data as TranscriptEventMap["steering_delivered"];
        // Realization: each drained id renders exactly once, at the delivery
        // point. An entry the structural buffer already flushed sits at the
        // batch-drain position the reducer wrote — leave it there (delivery
        // wins by rendering in place, never twice).
        const anchored: ProjectedMessage[] = [];
        for (const id of data.ids) {
          const target = claimQueued(id);
          if (!target) continue;
          if (messages.indexOf(target.entry) >= 0) continue;
          const buffered = steering.indexOf(target.entry);
          if (buffered >= 0) steering.splice(buffered, 1);
          if (target.openSeq < openSeq && messagesSinceTurnOpen === 0) {
            // Cross-turn realization (the D11b idle pre-flush): the durable
            // log records the opening `user_message` BEFORE this event, but
            // the reducer renders [...olderQueue, newUserMsg] — anchor the
            // older entries at the turn's opening instead of inverting them.
            anchored.push(target.entry);
          } else {
            messages.push(target.entry);
            messagesSinceTurnOpen += 1;
          }
        }
        if (anchored.length > 0) {
          // FIFO among anchored runs: after the previous run if any, else
          // before the turn's opening user_message, else at the tail.
          const anchor = openingAnchor ?? turnOpenEntry;
          let at = anchor !== undefined ? messages.indexOf(anchor) : -1;
          if (at === -1) at = messages.length;
          else if (openingAnchor !== undefined) at += 1;
          messages.splice(at, 0, ...anchored);
          openingAnchor = anchored[anchored.length - 1]!;
        }
        break;
      }

      case "turn_end": {
        // Termination pairing (D12) — mirrors synthesizeInterruptedResults
        // (reducer.ts): a turn that ends with a batch still in flight pairs
        // every un-fulfilled tool_use before the history is reused. The
        // resolved entries ARE the reducer's `_toolResultBuffer` (every
        // buffered result produced a tool_result event), so they ship
        // as-is; only the missing ids get the interrupted placeholder, in
        // roster order. Steering is NOT drained here: the reducer leaves
        // queuedUserInputs for the host auto-run, and the projection drops
        // it at end-of-log (below).
        if (batch) {
          const end = event.data as TranscriptEventMap["turn_end"];
          const tier = end.reason === "cancelled" ? "cancel" : "limit";
          for (const id of batch.roster) {
            const resolved = batch.resolved.get(id);
            // A buffered result ships as-is whatever its arrival-time order:
            // the reducer's synthesis reads the buffer by id, unconditionally.
            if (resolved !== undefined) {
              messages.push(resolved.entry);
              continue;
            }
            const block: ToolResultContent = {
              type: "tool_result",
              toolUseId: id,
              content: normalizeToolResultContent(
                interruptionMessageFor(toolNamesById.get(id) ?? "tool", tier),
              ),
              isError: true,
            };
            messages.push({
              message: { id: nextProjId(), role: "tool", content: [block] },
              time: event.time,
            });
          }
          batch = undefined;
          messagesSinceTurnOpen += 1;
        }
        break;
      }

      case "compaction": {
        const data = event.data as TranscriptEventMap["compaction"];
        // Legacy events (pre-write-back) carry no replacedIds/summaryId —
        // they record that compaction happened on the request surface only.
        // Without ids there is nothing to replay; skip, matching old behavior.
        if (data.replacedIds === undefined || data.summaryId === undefined) break;

        // Same position rule as the reducer's compaction_applied handler
        // (reducer.ts compaction_applied case): remove the named messages,
        // insert one USER-role summary at the earliest replaced position
        // among the kept order, and — when the event carries preserved
        // images — the user-role carrier at summary position + 1.
        // The user role is deliberate: a system summary would be hoisted
        // ahead of the static context layers by the ContextAssembler and
        // break the provider prefix cache (see reducer.ts).
        const replaced = new Set(data.replacedIds);
        const firstIdx = messages.findIndex((e) => replaced.has(e.message.id));
        // No projected id matched replacedIds. Current logs carry durable
        // `messageId`s on user/assistant/tool_result events, so a normal
        // write-back matches; legacy logs (events without identity) and a
        // summary span containing only synthesized messages (a denial or an
        // interrupted result) land here. Skip entirely rather than inventing
        // a summary at index 0.
        if (firstIdx === -1) break;
        const kept = messages.filter((e) => !replaced.has(e.message.id));
        const insertAt = messages.slice(0, firstIdx).filter((e) => !replaced.has(e.message.id)).length;
        const summaryEntry: ProjectedMessage = {
          message: {
            id: data.summaryId,
            role: "user",
            content: `[Earlier conversation summary]\n${data.summaryText}`,
          },
          time: event.time,
        };
        // D5 v1.2 carrier replay: the event carries ref METADATA only (id /
        // mediaType / dims — never bytes), so the marker text is re-rendered
        // here, byte-identical to how the reducer rendered it at write time.
        // Same id as the reducer's carrier (`${summaryId}-images`) and the
        // same [marker, image ref] pair order. Events without the field
        // (older logs) insert no carrier — unchanged replay.
        const imagesEntry: ProjectedMessage | undefined =
          data.preservedImages === undefined || data.preservedImages.length === 0
            ? undefined
            : {
                message: {
                  id: `${data.summaryId}-images`,
                  role: "user",
                  content: data.preservedImages.flatMap<ContentBlock>((image) => [
                    {
                      type: "text",
                      text: renderImagePreservedMarker({
                        ...(image.width !== undefined ? { width: image.width } : {}),
                        ...(image.height !== undefined ? { height: image.height } : {}),
                        mediaType: image.mediaType,
                      }),
                    },
                    {
                      type: "image",
                      source: { type: "ref", id: image.id, mediaType: image.mediaType },
                      ...(image.width !== undefined ? { width: image.width } : {}),
                      ...(image.height !== undefined ? { height: image.height } : {}),
                    },
                  ]),
                },
                time: event.time,
              };
        messages.length = 0;
        messages.push(
          ...kept.slice(0, insertAt),
          summaryEntry,
          ...(imagesEntry !== undefined ? [imagesEntry] : []),
          ...kept.slice(insertAt),
        );
        messagesSinceTurnOpen += 1;
        break;
      }

      default:
        // Every other event type is log-only: it records what happened but
        // does not itself become a message the model sees. In particular
        // `tool_results_pruned` stays log-only here — the event deliberately
        // omits pruned content (reducer.ts:236-237), so the projection has
        // nothing to rewrite with. On cold-start resume tool results keep
        // their original content; the Runner re-prunes on the request
        // surface before each model call, so the MODEL still sees pruned
        // text. Only state.messages (post write-back) diverges from the
        // projection until the next prune.
        break;
    }
  }

  // No trailing flush: an incomplete batch at end-of-log means the log never
  // reached `turn_end` — a crash mid-turn, where the reducer likewise never
  // processed a termination input and `resetTurnForNextInput` cleared the
  // roster silently. (A turn that DID end pairs its batch at `turn_end`,
  // above.) An unflushed steering queue is dropped for the same reason as
  // ever: the reducer keeps it in `queuedUserInputs` for the host auto-run,
  // never in `messages`. Flushing here would resurrect exactly that content.
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

/**
 * Collect every `image` attachment ref id reachable from a session's events.
 *
 * Pure structural walk: user/assistant content, tool_result content, and
 * compaction carriers all nest image blocks. Base64 images are ignored (they
 * carry their own bytes); ref images are the ids an attachment store must
 * copy when forking a session.
 */
export function collectAttachmentIds(events: readonly TranscriptEvent[]): string[] {
  const ids = new Set<string>();

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    if (record["type"] === "image") {
      const source = record["source"];
      if (typeof source === "object" && source !== null) {
        const src = source as Record<string, unknown>;
        if (src["type"] === "ref" && typeof src["id"] === "string") ids.add(src["id"]);
      }
      return;
    }
    for (const nested of Object.values(record)) visit(nested);
  };

  for (const event of events) {
    if (
      event.type === "user_message" ||
      event.type === "assistant_message" ||
      event.type === "tool_result" ||
      event.type === "compaction"
    ) {
      visit(event.data);
    }
  }
  return [...ids];
}
