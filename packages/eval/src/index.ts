/**
 * @voltojs/eval — trajectory replay and regression testing harness.
 *
 * Provides:
 * - Trajectory recording format (JSON-serializable)
 * - Replay runner (deterministic step-by-step comparison)
 * - First divergence point report
 * - Deterministic mock port suite for simulation
 */

// Trajectory format
export { createTrajectory, addStep, toExpectedStep } from "./trajectory.js";
export type { Trajectory, ExpectedStep, StateProjection } from "./trajectory.js";

// Replay runner + record path
export { replayTrajectory, recordTrajectory, observedStep } from "./replay.js";
export type { StepReplayResult, ReplayResult, ReplayOptions } from "./replay.js";

// Trajectory recorder
export { createTrajectoryRecorder } from "./recorder.js";
export type { TrajectoryRecorder } from "./recorder.js";

// Simulation (deterministic mock ports)
export {
  createSeededClock,
  createSeededId,
  createSeededRandom,
  createScriptedModelPort,
  createTrajectoryModelPort,
  createSimulation,
  simulateTrajectory,
} from "./simulate.js";
export type { SimulationPorts } from "./simulate.js";
