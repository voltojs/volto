/**
 * @volto/eval — trajectory replay and regression testing harness.
 *
 * Provides:
 * - Trajectory recording format (JSON-serializable)
 * - Replay runner (deterministic step-by-step comparison)
 * - First divergence point report
 * - Deterministic mock port suite for simulation
 */

// Trajectory format
export { createTrajectory, addStep } from "./trajectory.js";
export type { Trajectory, ExpectedStep } from "./trajectory.js";

// Replay runner
export { replayTrajectory } from "./replay.js";
export type { StepReplayResult, ReplayResult } from "./replay.js";

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
} from "./simulate.js";
export type { SimulationPorts } from "./simulate.js";
