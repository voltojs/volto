/**
 * Projects a durable event log back into the `Message[]` a session resume
 * needs. The single source of truth for "what did this conversation look
 * like" — the store performs no shape conversion of its own.
 *
 * Pure: no I/O, no clock, no randomness. Same events in, same messages out.
 */

import type { Message, ToolResultContent } from "./state.js";
import type { TranscriptEvent, TranscriptEventMap } from "./ports.js";

/** A projected message paired with the time of the event that produced it. */
export interface ProjectedMessage {
  message: Message;
  time: number;
}

/** One batch of tool results plus any steering messages queued during it. */
interface PendingBatch {
  results: Array<{ order: number; entry: ProjectedMessage }>;
  steering: ProjectedMessage[];
}

function emptyBatch(): PendingBatch {
  return { results: [], steering: [] };
}

/**
 * Flushes a batch in the exact order the reducer uses when all tools report:
 * `[...pendingTools-ordered results, ...queuedUserInputs]`. Steering messages
 * therefore land AFTER the batch's tool results even though they were emitted
 * (and so carry a smaller `seq`) while the tools were still running.
 */
function flush(batch: PendingBatch, out: ProjectedMessage[]): void {
  const ordered = [...batch.results].sort((a, b) => a.order - b.order);
  for (const item of ordered) out.push(item.entry);
  for (const entry of batch.steering) out.push(entry);
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
  let batch = emptyBatch();

  /** Any buffered batch must land before the next non-batch message. */
  const drain = (): void => {
    if (batch.results.length === 0 && batch.steering.length === 0) return;
    flush(batch, messages);
    batch = emptyBatch();
  };

  for (const event of events) {
    switch (event.type) {
      case "user_message": {
        drain();
        const data = event.data as TranscriptEventMap["user_message"];
        messages.push({ message: { role: "user", content: data.content }, time: event.time });
        break;
      }

      case "assistant_message": {
        drain();
        const data = event.data as TranscriptEventMap["assistant_message"];
        messages.push({
          message: {
            role: "assistant",
            content: data.content,
            ...(data.stopReason !== undefined ? { stopReason: data.stopReason } : {}),
          },
          time: event.time,
        });
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
        batch.results.push({
          order: data.orderInBatch,
          entry: { message: { role: "tool", content: [block] }, time: event.time },
        });
        break;
      }

      case "steering_queued": {
        const data = event.data as TranscriptEventMap["steering_queued"];
        batch.steering.push({
          message: { role: "user", content: data.content },
          time: event.time,
        });
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

  drain();
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
