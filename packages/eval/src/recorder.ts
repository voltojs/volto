import type { AgentInput, AgentState } from "@voltojs/core";
import type { Trajectory, ExpectedStep } from "./trajectory.js";
import { createTrajectory, addStep } from "./trajectory.js";

/** Options for a single capture call */
export interface CaptureOptions {
  /**
   * The FULL reducer state snapshot (all fields) to record into
   * `expected.fullState` for strict-mode replay (deep-equal (state, effects)
   * regression). The partial `state` argument of capture() remains the
   * legacy projection; passing this enables the strict full-state assertion.
   */
  fullState?: Record<string, unknown>;
  /**
   * The FULL effect objects (type + payload, in order) to record into
   * `expected.fullEffects` for strict-mode payload-level comparison.
   */
  fullEffects?: Array<Record<string, unknown>>;
}

export interface TrajectoryRecorder {
  start(name: string, stepContext: { model: string; maxTokens?: number }): void;
  capture(
    input: AgentInput,
    state: Pick<AgentState, "status" | "messages" | "pendingTools">,
    effectTypes: string[],
    opts?: CaptureOptions,
  ): void;
  stop(): Trajectory;
  toJSON(): string;
  fromJSON(json: string): void;
}

export function createTrajectoryRecorder(): TrajectoryRecorder {
  let trajectory: Trajectory | null = null;
  let recording = false;

  return {
    start(name, stepContext) {
      trajectory = createTrajectory(name, stepContext);
      recording = true;
    },

    capture(input, state, effectTypes, opts) {
      if (!recording || !trajectory) {
        throw new Error("TrajectoryRecorder: no active recording. Call start() first.");
      }
      const expected: ExpectedStep = {
        state: {
          status: state.status,
        },
        effects: effectTypes,
      };
      if (opts?.fullState) {
        // Full-state snapshot enables strict deep-equal replay. Copied so
        // later mutations of the live state cannot corrupt the recording.
        expected.fullState = structuredClone(opts.fullState);
      }
      if (opts?.fullEffects) {
        // Full effect objects (type + payload) for strict payload comparison.
        expected.fullEffects = structuredClone(opts.fullEffects);
      }
      addStep(trajectory, input, expected);
    },

    stop() {
      if (!trajectory) {
        throw new Error("TrajectoryRecorder: no active recording to stop.");
      }
      recording = false;
      return trajectory;
    },

    toJSON() {
      if (!trajectory) {
        throw new Error("TrajectoryRecorder: no trajectory to serialize.");
      }
      return JSON.stringify(trajectory);
    },

    fromJSON(json) {
      trajectory = JSON.parse(json) as Trajectory;
      recording = false;
    },
  };
}
