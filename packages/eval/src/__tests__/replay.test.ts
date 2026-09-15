import { describe, it, expect } from "vitest";
import { replayTrajectory } from "../replay.js";
import type { Trajectory } from "../trajectory.js";
import type { StepContext } from "@volto/core";

const ctx: StepContext = {
  tools: [],
  model: "test",
  maxTokens: 100,
};

describe("replayTrajectory", () => {
  it("passes when actual matches expected", () => {
    const traj: Trajectory = {
      name: "simple",
      stepContext: { model: "test" },
      inputs: [
        { type: "user_message", content: "hello" },
      ],
      expected: [
        {
          state: { status: "calling_model" },
          effects: ["call_model", "emit"], // user_message → call_model + emit
        },
      ],
    };

    const result = replayTrajectory(traj, ctx);
    expect(result.passed).toBe(true);
    expect(result.firstFailureIndex).toBe(-1);
    expect(result.totalSteps).toBe(1);
  });

  it("fails when status doesn't match", () => {
    const traj: Trajectory = {
      name: "mismatch",
      stepContext: { model: "test" },
      inputs: [
        { type: "user_message", content: "hello" },
      ],
      expected: [
        {
          state: { status: "done" }, // wrong — should be calling_model
          effects: [],
        },
      ],
    };

    const result = replayTrajectory(traj, ctx);
    expect(result.passed).toBe(false);
    expect(result.firstFailureIndex).toBe(0);
    expect(result.steps[0]!.diff).toContain("status");
  });

  it("fails when effects don't match", () => {
    const traj: Trajectory = {
      name: "effect-mismatch",
      stepContext: { model: "test" },
      inputs: [
        { type: "user_message", content: "hello" },
      ],
      expected: [
        {
          state: { status: "calling_model" },
          effects: ["nonexistent_effect"], // not produced
        },
      ],
    };

    const result = replayTrajectory(traj, ctx);
    expect(result.passed).toBe(false);
    expect(result.steps[0]!.diff).toContain("missing effects");
  });

  it("reports first divergence point correctly", () => {
    const traj: Trajectory = {
      name: "multi-step",
      stepContext: { model: "test" },
      inputs: [
        { type: "user_message", content: "hi" },
        { type: "model_done", stopReason: "end_turn" },
      ],
      expected: [
        {
          state: { status: "calling_model" },
          effects: ["call_model", "emit"],
        },
        {
          state: { status: "done" },
          effects: ["emit", "done"], // model_done produces emit + done
        },
      ],
    };

    const result = replayTrajectory(traj, ctx);
    expect(result.passed).toBe(true);
  });

  it("returns empty trajectory results", () => {
    const traj: Trajectory = {
      name: "empty",
      stepContext: { model: "test" },
      inputs: [],
      expected: [],
    };

    const result = replayTrajectory(traj, ctx);
    expect(result.passed).toBe(true);
    expect(result.totalSteps).toBe(0);
    expect(result.summary).toContain("All 0 steps");
  });

  it("summary contains failure info", () => {
    const traj: Trajectory = {
      name: "fail",
      stepContext: { model: "test" },
      inputs: [
        { type: "user_message", content: "hello" },
      ],
      expected: [
        {
          state: { status: "done" }, // wrong
          effects: [],
        },
      ],
    };

    const result = replayTrajectory(traj, ctx);
    expect(result.summary).toContain("Failed at step 0");
  });
});

describe("replayTrajectory (strict mode)", () => {
  // Recorded from the actual reducer: step(createInitialState(), user_message)
  const callModelEffect = {
    type: "call_model",
    request: {
      messages: [{ id: "", role: "user", content: "hello" }],
      tools: [],
      model: "test",
      maxTokens: 100,
      cacheBreakpoints: [0],
      layerOrigins: [],
    },
  };
  const emitEffect = { type: "emit", event: { type: "user_message", data: { content: "hello" } } };

  it("passes when full (state, effects) match", () => {
    const traj: Trajectory = {
      name: "strict-ok",
      stepContext: { model: "test" },
      inputs: [{ type: "user_message", content: "hello" }],
      expected: [
        {
          state: { status: "calling_model" },
          effects: ["call_model", "emit"],
          fullState: {
            status: "calling_model",
            messages: [{ id: "", role: "user", content: "hello" }],
            pendingTools: [],
            tokensUsed: 0,
          },
          fullEffects: [callModelEffect, emitEffect],
        },
      ],
    };

    const result = replayTrajectory(traj, ctx, { strict: true });
    expect(result.passed).toBe(true);
    expect(result.firstFailureIndex).toBe(-1);
  });

  it("fails on effect payload divergence and reports the first divergence", () => {
    const traj: Trajectory = {
      name: "strict-effect-mismatch",
      stepContext: { model: "test" },
      inputs: [{ type: "user_message", content: "hello" }],
      expected: [
        {
          state: { status: "calling_model" },
          effects: ["call_model", "emit"],
          fullState: {
            status: "calling_model",
            messages: [{ id: "", role: "user", content: "hello" }],
            pendingTools: [],
          },
          fullEffects: [
            { ...callModelEffect, request: { ...callModelEffect.request, maxTokens: 200 } }, // wrong
            emitEffect,
          ],
        },
      ],
    };

    const result = replayTrajectory(traj, ctx, { strict: true });
    expect(result.passed).toBe(false);
    expect(result.firstFailureIndex).toBe(0);
    expect(result.steps[0]!.diff).toContain("effects[0]");
    expect(result.steps[0]!.diff).toContain("maxTokens");
  });

  it("fails on full-state divergence and reports the state key", () => {
    const traj: Trajectory = {
      name: "strict-state-mismatch",
      stepContext: { model: "test" },
      inputs: [{ type: "user_message", content: "hello" }],
      expected: [
        {
          state: { status: "calling_model" },
          effects: ["call_model", "emit"],
          fullState: {
            status: "calling_model",
            messages: [{ id: "", role: "user", content: "hello" }],
            pendingTools: [],
            tokensUsed: 42, // wrong — actual is 0
          },
          fullEffects: [callModelEffect, emitEffect],
        },
      ],
    };

    const result = replayTrajectory(traj, ctx, { strict: true });
    expect(result.passed).toBe(false);
    expect(result.firstFailureIndex).toBe(0);
    expect(result.steps[0]!.diff).toContain("state.tokensUsed");
  });

  it("falls back to type-name comparison for legacy trajectories", () => {
    const traj: Trajectory = {
      name: "strict-legacy",
      stepContext: { model: "test" },
      inputs: [{ type: "user_message", content: "hello" }],
      expected: [
        {
          state: { status: "calling_model" },
          effects: ["call_model", "emit"], // no fullState / fullEffects
        },
      ],
    };

    const result = replayTrajectory(traj, ctx, { strict: true });
    expect(result.passed).toBe(true);
  });
});
