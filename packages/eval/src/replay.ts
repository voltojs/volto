/**
 * Replay — deterministic replay runner for trajectories.
 *
 * Feeds a recorded trajectory through step() and compares the actual
 * (state, effects) against expected outcomes at each step.
 * Returns the first divergence point with a structured diff.
 */

import { step, createInitialState } from "@voltojs/core";
import type { AgentInput, Effect } from "@voltojs/core";
import type { StepContext, ReducerState } from "@voltojs/core";
import type { Trajectory, ExpectedStep, StateProjection } from "./trajectory.js";
import { toExpectedStep } from "./trajectory.js";

/** Result of a single step replay */
export interface StepReplayResult {
  stepIndex: number;
  input: AgentInput;
  passed: boolean;
  actualState: StateProjection;
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
  /**
   * Index of the first step that carried no `fullState` to compare against
   * (-1 when every step was strictly decidable). Such a step can only be
   * checked against the partial projection, which strict replay cannot tell
   * apart from a full-state mismatch — callers that enforce strictness (the
   * CI gate) treat it as a failure, since exactly that blind spot is how the
   * fixtures drifted stale.
   */
  firstUndecidableIndex: number;
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
 * Project one step() result into its recorded form: the partial `state`
 * projection plus the full state snapshot and full effect objects.
 */
export function observedStep(
  state: ReducerState,
  effects: readonly Effect[],
): ExpectedStep {
  return toExpectedStep(
    state,
    effects.map((e) => e.type),
    state as unknown as Record<string, unknown>,
    effects as unknown as Array<Record<string, unknown>>,
  );
}

/**
 * Run a trajectory's inputs through the step() reducer without comparing
 * anything, projecting each step into the recorded form (`expected` entry)
 * via {@link toExpectedStep} — the same mapping the recorder uses. This is the
 * shared record path behind `--record`; it never mutates the input trajectory.
 */
export function recordTrajectory(
  trajectory: Trajectory,
  ctx: StepContext,
): ExpectedStep[] {
  let state: ReducerState = createInitialState();
  const expected: ExpectedStep[] = [];
  for (const input of trajectory.inputs) {
    const result = step(state, input, ctx);
    state = result.state;
    expected.push(observedStep(state, result.effects));
  }
  return expected;
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
  let firstUndecidableIndex = -1;

  for (let i = 0; i < trajectory.inputs.length; i++) {
    const input = trajectory.inputs[i]!;
    const expected = trajectory.expected[i]!;

    // Feed the input through the pure reducer
    const result = step(state, input, ctx);
    state = result.state;

    // Extract actual outcomes through the shared record mapping, so what
    // replay reports as "actual" is exactly what --record would write.
    const actual = observedStep(state, result.effects);
    const actualState = actual.state;
    const actualEffects = actual.effects;

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

    // fullState is strict replay's strongest assertion; without it the step
    // only proves the partial projection, which is undecidable even when the
    // recorded projection happens to match.
    if (expected.fullState === undefined && firstUndecidableIndex === -1) {
      firstUndecidableIndex = i;
    }
    if (!passed && firstFailureIndex === -1) {
      firstFailureIndex = i;
    }
  }

  const summary = firstFailureIndex !== -1
    ? `Failed at step ${firstFailureIndex}: ${stepResults[firstFailureIndex]!.diff}`
    : firstUndecidableIndex !== -1
      ? `Step ${firstUndecidableIndex} has no expected.fullState to deep-compare (recorded without the full state snapshot)`
      : `All ${trajectory.inputs.length} steps passed.`;

  return {
    trajectoryName: trajectory.name,
    totalSteps: trajectory.inputs.length,
    passed: firstFailureIndex === -1,
    firstFailureIndex,
    firstUndecidableIndex,
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
  actualState: StateProjection,
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
