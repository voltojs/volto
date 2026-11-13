import { describe, it, expect } from "vitest";
import { replayTrajectory, recordTrajectory } from "../replay.js";
import type { Trajectory } from "../trajectory.js";
import type { StepContext } from "@voltojs/core";

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
          effects: ["emit", "call_model"], // user_message → call_model + emit
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
          effects: ["emit", "call_model"],
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
          effects: ["emit", "call_model"],
          fullState: {
            status: "calling_model",
            messages: [{ id: "", role: "user", content: "hello" }],
            pendingTools: [],
            tokensUsed: 0,
          },
          fullEffects: [emitEffect, callModelEffect],
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
          effects: ["emit", "call_model"],
          fullState: {
            status: "calling_model",
            messages: [{ id: "", role: "user", content: "hello" }],
            pendingTools: [],
          },
          fullEffects: [
            emitEffect,
            { ...callModelEffect, request: { ...callModelEffect.request, maxTokens: 200 } }, // wrong
          ],
        },
      ],
    };

    const result = replayTrajectory(traj, ctx, { strict: true });
    expect(result.passed).toBe(false);
    expect(result.firstFailureIndex).toBe(0);
    expect(result.steps[0]!.diff).toContain("effects[1]");
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
          effects: ["emit", "call_model"],
          fullState: {
            status: "calling_model",
            messages: [{ id: "", role: "user", content: "hello" }],
            pendingTools: [],
            tokensUsed: 42, // wrong — actual is 0
          },
          fullEffects: [emitEffect, callModelEffect],
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
          effects: ["emit", "call_model"], // no fullState / fullEffects
        },
      ],
    };

    const result = replayTrajectory(traj, ctx, { strict: true });
    expect(result.passed).toBe(true);
    // ...but it only proves the partial projection, which strict replay must
    // not report as a decidable pass.
    expect(result.firstUndecidableIndex).toBe(0);
    expect(result.summary).toContain("no expected.fullState");
  });
});

describe("recordTrajectory", () => {
  const inputs: Trajectory["inputs"] = [
    { type: "user_message", content: "hello" },
    { type: "model_done", stopReason: "end_turn" },
  ];

  it("records expected steps that strict replay accepts", () => {
    const traj: Trajectory = {
      name: "record-roundtrip",
      stepContext: { model: "test", maxTokens: 100, tools: [] },
      inputs: structuredClone(inputs),
      expected: [],
    };

    const recorded: Trajectory = { ...traj, expected: recordTrajectory(traj, ctx) };
    expect(recorded.expected).toHaveLength(inputs.length);
    for (const step of recorded.expected) {
      expect(step.fullState).toBeDefined();
      expect(step.fullEffects).toBeDefined();
      expect(step.effects).toEqual(step.fullEffects!.map((e) => e.type));
    }

    const result = replayTrajectory(recorded, ctx, { strict: true });
    expect(result.passed).toBe(true);
    expect(result.firstUndecidableIndex).toBe(-1);
  });

  it("is deterministic across runs", () => {
    const traj: Trajectory = {
      name: "record-deterministic",
      stepContext: { model: "test", maxTokens: 100, tools: [] },
      inputs: structuredClone(inputs),
      expected: [],
    };

    expect(JSON.stringify(recordTrajectory(traj, ctx))).toBe(
      JSON.stringify(recordTrajectory(traj, ctx)),
    );
  });

  it("does not mutate the input trajectory and survives JSON round-trip", () => {
    const traj: Trajectory = {
      name: "record-pure",
      stepContext: { model: "test", maxTokens: 100, tools: [] },
      inputs: structuredClone(inputs),
      expected: [],
    };
    const before = JSON.stringify(traj);

    const expected = recordTrajectory(traj, ctx);
    expect(JSON.stringify(traj)).toBe(before);

    expect(JSON.parse(JSON.stringify(expected))).toEqual(expected);
  });
});
