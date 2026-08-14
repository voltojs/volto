/**
 * Trajectory — recording format for agent session traces.
 *
 * A trajectory captures the inputs and expected outcomes of an agent session
 * step-by-step, enabling deterministic replay and regression testing.
 */

import type { AgentInput, AgentState, ToolDefinition } from "@volto/core";

/** A single step's expected outcome */
export interface ExpectedStep {
  /** Expected state snapshot after this step (partial match) */
  state: Partial<Pick<AgentState, "status" | "messages" | "pendingTools">>;
  /** Expected effects (type names) emitted by this step */
  effects: string[];
  /**
   * Full state snapshot for strict-mode replay (deep-equal comparison).
   * Recorded by the recorder when capture() is called with `fullState: true`.
   * Absent in legacy trajectories — strict replay falls back to the partial
   * `state` comparison when this is missing.
   */
  fullState?: Record<string, unknown>;
  /**
   * Full effect objects (type + payload) for strict-mode replay. Recorded by
   * the recorder when capture() receives `fullEffects`. When absent, strict
   * replay compares effect type names only.
   */
  fullEffects?: Array<Record<string, unknown>>;
}

/** A recorded trajectory — the complete input + expected outcome sequence */
export interface Trajectory {
  /** Human-readable name for this trajectory */
  name: string;
  /** Step context used during recording (tools, model, etc.) */
  stepContext: {
    model: string;
    maxTokens?: number;
    /**
     * Tool definitions in scope during recording. Replay needs them to
     * correctly process tool-related inputs (e.g. tool_result validation);
     * absent in legacy trajectories → replay uses an empty tool set.
     */
    tools?: ToolDefinition[];
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
