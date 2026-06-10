/**
 * Replay — deterministic replay runner for trajectories.
 *
 * Feeds a recorded trajectory through step() and compares the actual
 * (state, effects) against expected outcomes at each step.
 * Returns the first divergence point with a structured diff.
 */

import { step, createInitialState } from "@agent-core/core";
import type { AgentInput, AgentState } from "@agent-core/core";
import type { StepContext, ReducerState } from "@agent-core/core";
import type { Trajectory, ExpectedStep } from "./trajectory.js";

/** Result of a single step replay */
export interface StepReplayResult {
  stepIndex: number;
  input: AgentInput;
  passed: boolean;
  actualState: Partial<Pick<AgentState, "status" | "messages" | "pendingTools">>;
  expectedState: ExpectedStep["state"];
  /** Effect type names produced by this step */
  actualEffects: string[];
  expectedEffects: string[];
  /** Diff description if failed */
  diff?: string;
}

/** Complete replay result */
export interface ReplayResult {
  trajectoryName: string;
  totalSteps: number;
  passed: boolean;
  /** Index of first failed step (-1 if all passed) */
  firstFailureIndex: number;
  /** All step results */
  steps: StepReplayResult[];
  /** Summary message */
  summary: string;
}

/**
 * Replay a trajectory through the step() reducer and compare results.
 *
 * @param trajectory - the recorded trajectory to replay
 * @param ctx - the step context (tools, model, etc.) to use for replay
 */
export function replayTrajectory(
  trajectory: Trajectory,
  ctx: StepContext,
): ReplayResult {
  let state: ReducerState = createInitialState();
  const stepResults: StepReplayResult[] = [];
  let firstFailureIndex = -1;

  for (let i = 0; i < trajectory.inputs.length; i++) {
    const input = trajectory.inputs[i]!;
    const expected = trajectory.expected[i]!;

    // Feed the input through the pure reducer
    const result = step(state, input, ctx);
    state = result.state;

    // Extract actual outcomes
    const actualState: Partial<Pick<AgentState, "status" | "messages" | "pendingTools">> = {
      status: state.status,
      messages: state.messages,
      pendingTools: state.pendingTools,
    };
    const actualEffects = result.effects.map((e) => e.type);

    // Compare
    const diff = compareStep(actualState, actualEffects, expected);
    const passed = diff === null;

    const stepResult: StepReplayResult = {
      stepIndex: i,
      input,
      passed,
      actualState,
      expectedState: expected.state,
      actualEffects,
      expectedEffects: expected.effects,
      diff: diff ?? undefined,
    };
    stepResults.push(stepResult);

    if (!passed && firstFailureIndex === -1) {
      firstFailureIndex = i;
    }
  }

  const totalPassed = stepResults.filter((s) => s.passed).length;
  const summary = firstFailureIndex === -1
    ? `All ${trajectory.inputs.length} steps passed.`
    : `Failed at step ${firstFailureIndex}: ${stepResults[firstFailureIndex]!.diff}`;

  return {
    trajectoryName: trajectory.name,
    totalSteps: trajectory.inputs.length,
    passed: firstFailureIndex === -1,
    firstFailureIndex,
    steps: stepResults,
    summary,
  };
}

/**
 * Compare actual vs expected for a single step.
 * Returns null if match, or a diff description string.
 */
function compareStep(
  actualState: Partial<Pick<AgentState, "status" | "messages" | "pendingTools">>,
  actualEffects: string[],
  expected: ExpectedStep,
): string | null {
  const diffs: string[] = [];

  // Compare status
  if (expected.state.status !== undefined && actualState.status !== expected.state.status) {
    diffs.push(`status: expected "${expected.state.status}", got "${actualState.status}"`);
  }

  // Compare message count
  if (expected.state.messages !== undefined) {
    if (actualState.messages?.length !== expected.state.messages.length) {
      diffs.push(
        `messages.length: expected ${expected.state.messages.length}, got ${actualState.messages?.length ?? 0}`,
      );
    }
  }

  // Compare pending tools count
  if (expected.state.pendingTools !== undefined) {
    if (actualState.pendingTools?.length !== expected.state.pendingTools.length) {
      diffs.push(
        `pendingTools.length: expected ${expected.state.pendingTools.length}, got ${actualState.pendingTools?.length ?? 0}`,
      );
    }
  }

  // Compare effects (type names)
  if (expected.effects.length > 0) {
    const missingEffects = expected.effects.filter((e) => !actualEffects.includes(e));
    const extraEffects = actualEffects.filter((e) => !expected.effects.includes(e));
    if (missingEffects.length > 0) {
      diffs.push(`missing effects: ${missingEffects.join(", ")}`);
    }
    if (extraEffects.length > 0) {
      diffs.push(`unexpected effects: ${extraEffects.join(", ")}`);
    }
  }

  return diffs.length > 0 ? diffs.join("; ") : null;
}
