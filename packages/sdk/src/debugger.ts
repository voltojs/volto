/**
 * Time-travel debugger — API for listing, rewinding, stepping, and diffing
 * checkpoint history. Uses SessionStore's multi-key ability (sessionId#seq)
 * without modifying the SessionStore port.
 *
 * NOTE on "rewind & continue": a checkpoint state is typically a terminal
 * `done` state, which the reducer rejects inputs on. To resume running from
 * a rewound state, apply `resetTurnForNextInput` (from @voltojs/core) — the
 * same primitive createAgent uses to carry cross-turn state (messages,
 * readFiles, and the un-delivered steering queue in `queuedUserInputs`,
 * which it preserves rather than clears) across turns while clearing the
 * turn-scoped accumulators — and pass the result as the runner's
 * `initialState`. See runner-time-travel tests.
 */

import type { SessionStore, ReducerState } from "@voltojs/core";
import { step, diffState, createInitialState } from "@voltojs/core";
import type { StepContext } from "@voltojs/core";
import type { StateDiff } from "@voltojs/core";

export interface Checkpoint {
  seq: number;
  state: ReducerState;
  createdAt: number;
}

export interface DebuggerOptions {
  sessionStore: SessionStore;
  sessionId: string;
  /** StepContext for single-step replay (tools + model config) */
  stepContext: StepContext;
}

export interface TimeTravelDebugger {
  /** List all checkpoints for the session, sorted by seq ascending */
  listCheckpoints(): Promise<Checkpoint[]>;

  /** Load the state at a specific checkpoint seq */
  rewindTo(seq: number): Promise<ReducerState>;

  /** Single-step replay: given a state, apply an input via pure step() */
  stepForward(state: ReducerState, input: Parameters<typeof step>[1]): {
    state: ReducerState;
    effects: ReturnType<typeof step>["effects"];
  };

  /** Compute structured diff between two states */
  diff(a: ReducerState, b: ReducerState): StateDiff;
}

export function createTimeTravelDebugger(opts: DebuggerOptions): TimeTravelDebugger {
  const { sessionStore, sessionId, stepContext } = opts;

  return {
    async listCheckpoints(): Promise<Checkpoint[]> {
      const prefix = `${sessionId}#`;
      const all = await sessionStore.list();
      const checkpoints: Checkpoint[] = [];
      for (const snap of all) {
        if (snap.id.startsWith(prefix)) {
          const seqStr = snap.id.slice(prefix.length);
          const seq = parseInt(seqStr, 10);
          if (!isNaN(seq)) {
            checkpoints.push({
              seq,
              state: snap.state as ReducerState,
              createdAt: snap.createdAt,
            });
          }
        }
      }
      checkpoints.sort((a, b) => a.seq - b.seq);
      return checkpoints;
    },

    async rewindTo(seq: number): Promise<ReducerState> {
      const snapshot = await sessionStore.load(`${sessionId}#${seq}`);
      if (!snapshot) {
        throw new Error(`Checkpoint not found: ${sessionId}#${seq}`);
      }
      return snapshot.state as ReducerState;
    },

    stepForward(state: ReducerState, input: Parameters<typeof step>[1]) {
      const result = step(state, input, stepContext);
      return { state: result.state, effects: result.effects };
    },

    diff(a: ReducerState, b: ReducerState): StateDiff {
      return diffState(a, b);
    },
  };
}

/** Create an empty initial state for debugger seeding */
export { createInitialState };

/** Re-exported for hosts that want to diff states without importing core */
export { diffState };
export type { StateDiff } from "@voltojs/core";
