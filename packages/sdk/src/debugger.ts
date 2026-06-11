/**
 * Time-travel debugger — API for listing, rewinding, stepping, and diffing
 * checkpoint history. Uses SessionStore's multi-key ability (sessionId#seq)
 * without modifying the SessionStore port.
 */

import type { SessionStore, ReducerState } from "@agent-core/core";
import { step, diffState, createInitialState } from "@agent-core/core";
import type { StepContext } from "@agent-core/core";
import type { StateDiff } from "@agent-core/core";

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
      const checkpoints: Checkpoint[] = [];
      // Scan seq 1..N, stop at first miss
      for (let seq = 1; seq <= 10_000; seq++) {
        const snapshot = await sessionStore.load(`${sessionId}#${seq}`);
        if (!snapshot) break;
        checkpoints.push({
          seq,
          state: snapshot.state as ReducerState,
          createdAt: snapshot.createdAt,
        });
      }
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
