/**
 * Buffers transcript events and writes them in batches.
 *
 * Isolates "when do we hit the disk" from the Runner's "what just happened",
 * so the main loop never awaits a write mid-stream and never has to reason
 * about partial batches. Every failure is swallowed: a transcript is a
 * durable record of the turn, never a precondition for running it.
 */

import type {
  TranscriptEventInput,
  TranscriptEventMap,
  TranscriptEventType,
  TranscriptStore,
} from "@volto/core";

export interface TranscriptRecorderOptions {
  store: TranscriptStore | undefined;
  sessionId: string | undefined;
  /** This turn's ordinal within the whole conversation. */
  turn: number;
  /** Injected clock — the Runner passes its `opts.clock?.now ?? Date.now`. */
  now: () => number;
}

export interface RecordMeta {
  /** Which model call within the turn (1-based). Omit for turn-level events. */
  step?: number;
  /**
   * Explicit timestamp override. Use when the caller already read the clock
   * for this exact instant (e.g. model_call_start reusing the same reading
   * it stamps its own call-timing anchor with) — a second, independent
   * `now()` read here would diverge from it under a clock that advances per
   * call (real wall-clock jitter is negligible, but an injected stepping
   * clock makes the drift visible and load-bearing for anyone reconstructing
   * durations purely from event `time` fields). Omit to use `now()`.
   */
  time?: number;
}

export interface TranscriptRecorder {
  /** True when a store and session id are both configured. */
  readonly enabled: boolean;
  /** Buffers one event, stamping it with the current time and turn. */
  record<T extends TranscriptEventType>(
    type: T,
    data: TranscriptEventMap[T],
    meta?: RecordMeta,
  ): void;
  /** Writes everything buffered so far. Never rejects. */
  flush(): Promise<void>;
}

export function createTranscriptRecorder(opts: TranscriptRecorderOptions): TranscriptRecorder {
  const { store, sessionId, turn, now } = opts;
  const enabled = store !== undefined && sessionId !== undefined;
  let buffer: TranscriptEventInput[] = [];
  // Chains every write flush() has ever issued, so that:
  //  (a) writes don't race each other at the store if flush() is called
  //      again before the previous write lands, and
  //  (b) a caller that awaits flush() waits for *every* outstanding write,
  //      not just the batch this particular call happened to take — which
  //      matters because an earlier, un-awaited `void recorder.flush()`
  //      (used throughout the Runner for mid-turn best-effort writes) may
  //      already have drained the buffer, leaving nothing for this call to
  //      see but its write still in flight.
  let inFlight: Promise<void> = Promise.resolve();

  return {
    enabled,

    record(type, data, meta) {
      if (!enabled) return;
      buffer.push({
        time: meta?.time ?? now(),
        type,
        data,
        turn,
        ...(meta?.step !== undefined ? { step: meta.step } : {}),
      });
    },

    async flush() {
      if (!enabled) return;
      if (buffer.length > 0) {
        const batch = buffer;
        // Clear before the write starts: a failed write must not leave the
        // batch queued for the next flush, or a transient error would
        // duplicate every event.
        buffer = [];
        inFlight = inFlight.then(async () => {
          try {
            // Awaited inside its own try/catch rather than chained via
            // `.catch()` on the call's return value: a store that throws
            // synchronously (a plain, non-async implementation) never
            // produces a promise for `.catch()` to attach to — the throw
            // would instead propagate out of this `.then()` callback and
            // reject `inFlight` with no handler, permanently poisoning
            // every later flush() call's wait.
            await store!.appendEvents(sessionId!, batch);
          } catch {
            // Best-effort by contract — see the module comment. Swallowed
            // here (rather than left to propagate through the chain) so one
            // batch's failure can't poison every later batch's wait.
          }
        });
      }
      // Always wait on the chain, even when this call added nothing new —
      // that's what lets a later flush() observe an earlier one's write.
      await inFlight;
    },
  };
}
