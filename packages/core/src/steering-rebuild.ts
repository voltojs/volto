/**
 * D13 queue rebuild: fold a session's durable transcript events into the
 * steering queue that has NOT been delivered yet.
 *
 * The append-only event log is the single source of truth for "what is
 * still queued": `steering_queued{id}` appends an entry (FIFO),
 * `steering_edited{id}` rewrites its content in place, `steering_removed{id}`
 * drops it, and `steering_delivered{ids}` realizes entries out of the queue.
 * Hosts fold this at a rebuild / cold start and hand the result to
 * `CreateAgentOptions.initialQueuedInputs`, so a queued message survives an
 * instance swap or a process restart instead of living only in the previous
 * instance's memory.
 *
 * Pure by contract: no clock, no store, no I/O — a function of the event
 * array alone (core purity). Legacy events recorded before the feature
 * carry no `id` and cannot be addressed by id; they are ignored rather than
 * guessed at.
 */

import type { TranscriptEventInput, TranscriptEventMap } from "./ports.js";
import type { UserMessage } from "./state.js";

/**
 * Fold `events` in order into the queue entries that are still pending.
 *
 * Rules (spec D13):
 * - `steering_queued{id}` builds an entry with that id, keeping FIFO order;
 * - `steering_edited{id}` replaces the content, keeping id and position;
 * - `steering_removed{id}` drops the entry;
 * - `steering_delivered{ids}` drops every named id (delivery wins);
 * - events without an `id` (legacy, pre-feature) are ignored;
 * - repeated ids in `steering_delivered` are idempotent.
 *
 * Never throws on a malformed record: this reads an on-disk log that may
 * predate the feature, so every id is narrowed from an untyped view.
 */
export function pendingSteeredMessages(events: readonly TranscriptEventInput[]): UserMessage[] {
  const pending: UserMessage[] = [];
  const positionOf = (id: string): number => pending.findIndex((message) => message.id === id);

  for (const event of events) {
    switch (event.type) {
      case "steering_queued": {
        const data = event.data as TranscriptEventMap["steering_queued"];
        // Legacy events carry no id: not addressable, skipped without
        // throwing (same stance as the transcript projections).
        const id: unknown = (data as { id?: unknown }).id;
        if (typeof id !== "string") break;
        pending.push({ id, role: "user", content: data.content });
        break;
      }
      case "steering_edited": {
        const data = event.data as TranscriptEventMap["steering_edited"];
        const id: unknown = (data as { id?: unknown }).id;
        if (typeof id !== "string") break;
        // Same id, same position, new content — mirrors the reducer's
        // in-place edit. An id no longer queued (delivered or removed
        // first) is a no-op: delivery wins.
        const at = positionOf(id);
        if (at !== -1) pending[at] = { ...pending[at]!, content: data.content };
        break;
      }
      case "steering_removed": {
        const data = event.data as TranscriptEventMap["steering_removed"];
        const id: unknown = (data as { id?: unknown }).id;
        if (typeof id !== "string") break;
        const at = positionOf(id);
        if (at !== -1) pending.splice(at, 1);
        break;
      }
      case "steering_delivered": {
        const data = event.data as TranscriptEventMap["steering_delivered"];
        const ids: unknown = (data as { ids?: unknown }).ids;
        if (!Array.isArray(ids)) break;
        for (const raw of ids) {
          // Idempotent by construction: an id listed twice — or already
          // removed — simply finds nothing on the later pass.
          if (typeof raw !== "string") continue;
          const at = positionOf(raw);
          if (at !== -1) pending.splice(at, 1);
        }
        break;
      }
      default:
        break;
    }
  }
  return pending;
}
