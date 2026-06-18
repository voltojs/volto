import type { AgentInput, AgentState } from "@volto/core";
import type { Trajectory, ExpectedStep } from "./trajectory.js";
import { createTrajectory, addStep } from "./trajectory.js";

export interface TrajectoryRecorder {
  start(name: string, stepContext: { model: string; maxTokens?: number }): void;
  capture(
    input: AgentInput,
    state: Pick<AgentState, "status" | "messages" | "pendingTools">,
    effectTypes: string[],
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

    capture(input, state, effectTypes) {
      if (!recording || !trajectory) {
        throw new Error("TrajectoryRecorder: no active recording. Call start() first.");
      }
      const expected: ExpectedStep = {
        state: {
          status: state.status,
        },
        effects: effectTypes,
      };
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
