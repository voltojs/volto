import { describe, it, expect } from "vitest";
import { createTrajectoryRecorder } from "../recorder.js";
import { replayTrajectory } from "../replay.js";
import type { StepContext } from "@volto/core";

const ctx: StepContext = {
  tools: [],
  model: "test",
  maxTokens: 100,
};

describe("TrajectoryRecorder", () => {
  it("records steps and produces a valid trajectory", () => {
    const recorder = createTrajectoryRecorder();
    recorder.start("basic", { model: "test" });

    recorder.capture(
      { type: "user_message", content: "hello" },
      { status: "calling_model", messages: [{ role: "user", content: "hello" }], pendingTools: [] },
      ["call_model", "emit"],
    );

    recorder.capture(
      { type: "model_done", stopReason: "end_turn" },
      { status: "done", messages: [{ role: "user", content: "hello" }], pendingTools: [] },
      ["emit", "done"],
    );

    const traj = recorder.stop();
    expect(traj.name).toBe("basic");
    expect(traj.stepContext.model).toBe("test");
    expect(traj.inputs).toHaveLength(2);
    expect(traj.expected).toHaveLength(2);
    expect(traj.inputs[0]!.type).toBe("user_message");
    expect(traj.expected[0]!.effects).toEqual(["call_model", "emit"]);
    expect(traj.expected[1]!.state.status).toBe("done");
  });

  it("round-trips through JSON serialization", () => {
    const recorder = createTrajectoryRecorder();
    recorder.start("json-roundtrip", { model: "gpt-4", maxTokens: 500 });

    recorder.capture(
      { type: "user_message", content: "test" },
      { status: "calling_model", messages: [{ role: "user", content: "test" }], pendingTools: [] },
      ["call_model", "emit"],
    );

    const traj = recorder.stop();
    const json = recorder.toJSON();

    const recorder2 = createTrajectoryRecorder();
    recorder2.fromJSON(json);
    const restored = recorder2.stop();

    expect(restored.name).toBe(traj.name);
    expect(restored.stepContext).toEqual(traj.stepContext);
    expect(restored.inputs).toEqual(traj.inputs);
    expect(restored.expected).toEqual(traj.expected);
  });

  it("recorded trajectory passes replay", () => {
    const recorder = createTrajectoryRecorder();
    recorder.start("replay-test", { model: "test" });

    recorder.capture(
      { type: "user_message", content: "hello" },
      { status: "calling_model", messages: [{ role: "user", content: "hello" }], pendingTools: [] },
      ["call_model", "emit"],
    );

    recorder.capture(
      { type: "model_done", stopReason: "end_turn" },
      { status: "done", messages: [{ role: "user", content: "hello" }], pendingTools: [] },
      ["emit", "done"],
    );

    const traj = recorder.stop();
    const result = replayTrajectory(traj, ctx);

    expect(result.passed).toBe(true);
    expect(result.totalSteps).toBe(2);
    expect(result.firstFailureIndex).toBe(-1);
  });

  it("records full state + full effects for strict-mode replay", () => {
    const recorder = createTrajectoryRecorder();
    recorder.start("strict-replay", { model: "test" });

    recorder.capture(
      { type: "user_message", content: "hello" },
      { status: "calling_model", messages: [{ role: "user", content: "hello" }], pendingTools: [] },
      ["call_model", "emit"],
      {
        fullState: {
          status: "calling_model",
          messages: [{ role: "user", content: "hello" }],
          pendingTools: [],
          tokensUsed: 0,
        },
        fullEffects: [
          { type: "call_model", request: { messages: [{ role: "user", content: "hello" }], tools: [], model: "test", maxTokens: 100, cacheBreakpoints: [0], layerOrigins: [] } },
          { type: "emit", event: { type: "user_message", data: { content: "hello" } } },
        ],
      },
    );

    const traj = recorder.stop();
    expect(traj.expected[0]!.fullState).toBeDefined();
    expect(traj.expected[0]!.fullEffects).toHaveLength(2);

    // The recorded full snapshots must survive JSON round-trip (trajectory
    // files are stored on disk and replayed later).
    const recorder2 = createTrajectoryRecorder();
    recorder2.fromJSON(recorder.toJSON());
    const restored = recorder2.stop();

    const result = replayTrajectory(restored, ctx, { strict: true });
    expect(result.passed).toBe(true);
    expect(result.totalSteps).toBe(1);
  });

  it("throws when capturing without start", () => {
    const recorder = createTrajectoryRecorder();
    expect(() =>
      recorder.capture(
        { type: "user_message", content: "hi" },
        { status: "idle", messages: [], pendingTools: [] },
        [],
      ),
    ).toThrow("no active recording");
  });

  it("throws when stopping without start", () => {
    const recorder = createTrajectoryRecorder();
    expect(() => recorder.stop()).toThrow("no active recording");
  });
});
