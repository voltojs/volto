/**
 * Simulate — deterministic mock port suite for offline trajectory replay.
 *
 * Provides seeded Clock, Id, Random, and a mock ModelPort that replays
 * a scripted sequence of events. Together they form a fully deterministic
 * simulation environment for eval harness.
 */

import type {
  Clock,
  Id,
  Random,
  ModelPort,
  ModelRequest,
  ModelEvent,
} from "@voltojs/core";

// ──────────────────────────────────────────────
// Seeded PRNG (simple mulberry32)
// ──────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ──────────────────────────────────────────────
// Seeded Clock
// ──────────────────────────────────────────────

/**
 * Create a deterministic Clock that returns values from a seed.
 * Each call to `now()` advances by a fixed step (default 100ms).
 */
export function createSeededClock(opts?: { startMs?: number; stepMs?: number }): Clock {
  let time = opts?.startMs ?? 0;
  const step = opts?.stepMs ?? 100;
  return {
    now() {
      const current = time;
      time += step;
      return current;
    },
  };
}

// ──────────────────────────────────────────────
// Seeded Id
// ──────────────────────────────────────────────

/**
 * Create a deterministic Id generator.
 * Produces sequential IDs: eval-id-0, eval-id-1, etc.
 */
export function createSeededId(prefix?: string): Id {
  let counter = 0;
  return {
    next() {
      return `${prefix ?? "eval-id"}-${counter++}`;
    },
  };
}

// ──────────────────────────────────────────────
// Seeded Random
// ──────────────────────────────────────────────

/**
 * Create a deterministic Random using a seeded PRNG.
 */
export function createSeededRandom(seed?: number): Random {
  const rng = mulberry32(seed ?? 42);
  return {
    next() {
      return rng();
    },
  };
}

// ──────────────────────────────────────────────
// Scripted ModelPort
// ──────────────────────────────────────────────

/**
 * Create a ModelPort that replays a scripted sequence of event batches.
 * Each batch is yielded in order; within a batch, events are yielded
 * in the order provided.
 *
 * Useful for recording a model's behavior and replaying it deterministically.
 */
export function createScriptedModelPort(
  batches: ModelEvent[][],
): ModelPort {
  return {
    async *stream(_req: ModelRequest): AsyncIterable<ModelEvent> {
      for (const batch of batches) {
        for (const event of batch) {
          yield event;
        }
      }
      // Always yield a terminal done if no batches or last batch didn't end with done
      if (batches.length === 0 || batches[batches.length - 1]!.at(-1)?.type !== "done") {
        yield { type: "done", stopReason: "end_turn" };
      }
    },
  };
}

/**
 * Create a ModelPort that replays from a trajectory's recorded events.
 * Convenience wrapper for createScriptedModelPort.
 */
export function createTrajectoryModelPort(
  eventSequence: ModelEvent[],
): ModelPort {
  // Split into batches by "done" or "error" events
  const batches: ModelEvent[][] = [];
  let currentBatch: ModelEvent[] = [];

  for (const event of eventSequence) {
    currentBatch.push(event);
    if (event.type === "done" || event.type === "error") {
      batches.push(currentBatch);
      currentBatch = [];
    }
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return createScriptedModelPort(batches);
}

// ──────────────────────────────────────────────
// Simulation environment
// ──────────────────────────────────────────────

/** All deterministic ports needed for a fully offline simulation */
export interface SimulationPorts {
  clock: Clock;
  id: Id;
  random: Random;
  modelPort: ModelPort;
}

/**
 * Create a complete deterministic simulation environment.
 * Pass a seed to get reproducible results across runs.
 */
export function createSimulation(opts?: {
  seed?: number;
  modelBatches?: ModelEvent[][];
  startTimeMs?: number;
}): SimulationPorts {
  return {
    clock: createSeededClock({ startMs: opts?.startTimeMs }),
    id: createSeededId(),
    random: createSeededRandom(opts?.seed),
    modelPort: createScriptedModelPort(opts?.modelBatches ?? []),
  };
}
