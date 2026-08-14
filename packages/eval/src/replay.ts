/**
 * Replay — deterministic replay runner for trajectories.
 *
 * Feeds a recorded trajectory through step() and compares the actual
 * (state, effects) against expected outcomes at each step.
 * Returns the first divergence point with a structured diff.
 */

import { step, createInitialState } from "@volto/core";
import type { AgentInput, AgentState, Effect } from "@volto/core";
import type { StepContext, ReducerState } from "@volto/core";
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

/** Options controlling how replay compares actual vs expected */
export interface ReplayOptions {
  /**
   * Strict mode — assert FULL (state, effects) consistency, the M11 eval
   * acceptance: the same input sequence must produce the same (state, effects).
   * - effects are compared as complete objects (type + payload), in order
   * - state is deep-compared via `expected.fullState` when present, falling
   *   back to the partial projection for legacy trajectories
   * Default false = legacy comparison (state projection + effect type names).
   */
  strict?: boolean;
}

/**
 * Replay a trajectory through the step() reducer and compare results.
 *
 * @param trajectory - the recorded trajectory to replay
 * @param ctx - the step context (tools, model, etc.) to use for replay
 * @param opts - replay options (strict mode)
 */
export function replayTrajectory(
  trajectory: Trajectory,
  ctx: StepContext,
  opts?: ReplayOptions,
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
    const diff = opts?.strict
      ? compareStepStrict(state, result.effects, expected)
      : compareStep(actualState, actualEffects, expected);
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
 * Strict comparison — deep-equal on the FULL (state, effects) pair.
 * Returns null if match, or a diff description string locating the first
 * divergence.
 */
function compareStepStrict(
  actualState: ReducerState,
  actualEffects: readonly Effect[],
  expected: ExpectedStep,
): string | null {
  const diffs: string[] = [];

  // 1. Effects: full objects (type + payload) in order when the recording
  // carried them; otherwise fall back to type-name comparison (legacy).
  const actualEffectsFull = actualEffects.map((e) => ({ ...e }));
  if (expected.fullEffects !== undefined) {
    if (actualEffectsFull.length !== expected.fullEffects.length) {
      diffs.push(
        `effects length: expected ${expected.fullEffects.length}, got ${actualEffectsFull.length}`,
      );
    } else {
      for (let i = 0; i < expected.fullEffects.length; i++) {
        if (!deepEqual(actualEffectsFull[i], expected.fullEffects[i])) {
          diffs.push(
            `effects[${i}]: expected ${safeStringify(expected.fullEffects[i])}, got ${safeStringify(actualEffectsFull[i])}`,
          );
          break; // first divergence point only
        }
      }
    }
  } else {
    const expectedTypes = expected.effects;
    const actualTypes = actualEffectsFull.map((e) => e.type);
    if (actualTypes.length !== expectedTypes.length) {
      diffs.push(`effects length: expected ${expectedTypes.length}, got ${actualTypes.length}`);
    } else {
      for (let i = 0; i < expectedTypes.length; i++) {
        if (actualTypes[i] !== expectedTypes[i]) {
          diffs.push(`effects[${i}]: expected type "${expectedTypes[i]}", got "${actualTypes[i]}"`);
          break;
        }
      }
    }
  }

  // 2. State: full deep-equal when the recording carries fullState.
  if (expected.fullState !== undefined) {
    const actualFull = { ...(actualState as unknown as Record<string, unknown>) };
    const keys = Object.keys(expected.fullState).sort();
    for (const key of keys) {
      const expectedVal = expected.fullState[key];
      const actualVal = actualFull[key];
      if (!deepEqual(actualVal, expectedVal)) {
        diffs.push(
          `state.${key}: expected ${safeStringify(expectedVal)}, got ${safeStringify(actualVal)}`,
        );
        break; // first divergence point only
      }
    }
  }

  return diffs.length > 0 ? diffs.join("; ") : null;
}

/** JSON-safe stringify with undefined/function fallback */
function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

/** Structural deep equality (order-insensitive keys, undefined-aware).
 *
 * Keys whose value is `undefined` are treated as absent — this matches JSON
 * serialization semantics, so recorded trajectories (serialized to JSON) stay
 * comparable against live reducer output that may carry explicitly-undefined
 * optional fields (e.g. `temperature: undefined` in a ModelRequest).
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, (b as unknown[])[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const keyOf = (o: object): string[] =>
      Object.keys(o)
        .filter((k) => (o as Record<string, unknown>)[k] !== undefined)
        .sort();
    const aKeys = keyOf(a as Record<string, unknown>);
    const bKeys = keyOf(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    );
  }
  return false;
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

  // Compare effects (type names) — always compare, even when expected is empty
  const missingEffects = expected.effects.filter((e) => !actualEffects.includes(e));
  const extraEffects = actualEffects.filter((e) => !expected.effects.includes(e));
  if (missingEffects.length > 0) {
    diffs.push(`missing effects: ${missingEffects.join(", ")}`);
  }
  if (extraEffects.length > 0) {
    diffs.push(`unexpected effects: ${extraEffects.join(", ")}`);
  }

  return diffs.length > 0 ? diffs.join("; ") : null;
}
