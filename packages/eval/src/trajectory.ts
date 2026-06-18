/**
 * Trajectory — recording format for agent session traces.
 *
 * A trajectory captures the inputs and expected outcomes of an agent session
 * step-by-step, enabling deterministic replay and regression testing.
 */

import type { AgentInput, AgentState } from "@volto/core";

/** A single step's expected outcome */
export interface ExpectedStep {
  /** Expected state snapshot after this step (partial match) */
  state: Partial<Pick<AgentState, "status" | "messages" | "pendingTools">>;
  /** Expected effects (type names) emitted by this step */
  effects: string[];
}

/** A recorded trajectory — the complete input + expected outcome sequence */
export interface Trajectory {
  /** Human-readable name for this trajectory */
  name: string;
  /** Step context used during recording (tools, model, etc.) */
  stepContext: {
    model: string;
    maxTokens?: number;
  };
  /** Sequence of inputs fed to the agent */
  inputs: AgentInput[];
  /** Expected outcomes per step (same length as inputs) */
  expected: ExpectedStep[];
  /** Optional metadata for filtering / categorization */
  metadata?: Record<string, unknown>;
}

/**
 * Create an empty trajectory template.
 */
export function createTrajectory(
  name: string,
  stepContext: { model: string; maxTokens?: number },
): Trajectory {
  return {
    name,
    stepContext,
    inputs: [],
    expected: [],
  };
}

/**
 * Add a step to a trajectory (mutates the trajectory).
 */
export function addStep(
  traj: Trajectory,
  input: AgentInput,
  expected: ExpectedStep,
): void {
  traj.inputs.push(input);
  traj.expected.push(expected);
}
