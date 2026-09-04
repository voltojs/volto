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

  return {
    enabled,

    record(type, data, meta) {
      if (!enabled) return;
      buffer.push({
        time: now(),
        type,
        data,
        turn,
        ...(meta?.step !== undefined ? { step: meta.step } : {}),
      });
    },

    async flush() {
      if (!enabled || buffer.length === 0) return;
      const batch = buffer;
      // Clear before awaiting: a failed write must not leave the batch queued
      // for the next flush, or a transient error would duplicate every event.
      buffer = [];
      try {
        await store!.appendEvents(sessionId!, batch);
      } catch {
        // Best-effort by contract — see the module comment.
      }
    },
  };
}
