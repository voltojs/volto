/**
 * StreamChannel — bridges the Runner's synchronous EventSink.emit() calls
 * with the SDK's async stream() generator.
 *
 * The Runner calls emit() synchronously during step processing. This channel
 * queues events and resolves them when the async generator polls.
 */

import type { EventSink } from "@voltojs/core";

export interface StreamChannel {
  eventSink: EventSink;
  /** Async generator that yields queued events until the runner finishes. */
  events(): AsyncGenerator<{ type: string; data: Record<string, unknown> }>;
  /** Mark the runner as finished — the generator will terminate after draining. */
  done(): void;
}

export function createStreamChannel(): StreamChannel {
  const queue: Array<{ type: string; data: Record<string, unknown> }> = [];
  let resolvers: Array<(value: IteratorResult<{ type: string; data: Record<string, unknown> }>) => void> = [];
  let finished = false;

  return {
    eventSink: {
      emit(event) {
        if (resolvers.length > 0) {
          const resolve = resolvers.shift()!;
          resolve({ value: event, done: false });
        } else {
          queue.push(event);
        }
      },
    },

    done() {
      finished = true;
      // Wake up any waiting consumers so they can observe the done state
      for (const resolve of resolvers) {
        resolve({ value: undefined as unknown as { type: string; data: Record<string, unknown> }, done: true });
      }
      resolvers = [];
    },

    async *events() {
      while (true) {
        if (queue.length > 0) {
          const event = queue.shift()!;
          yield event;
          continue;
        }
        if (finished) return;

        // Wait for the next event or completion
        const result = await new Promise<IteratorResult<{ type: string; data: Record<string, unknown> }>>((resolve) => {
          resolvers.push(resolve);
        });
        if (result.done) return;
        yield result.value;
      }
    },
  };
}
