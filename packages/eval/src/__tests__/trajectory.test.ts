import { describe, it, expect } from "vitest";
import { createTrajectory, addStep } from "../trajectory.js";

describe("createTrajectory", () => {
  it("creates an empty trajectory", () => {
    const traj = createTrajectory("test", { model: "gpt-4" });
    expect(traj.name).toBe("test");
    expect(traj.stepContext.model).toBe("gpt-4");
    expect(traj.inputs).toHaveLength(0);
    expect(traj.expected).toHaveLength(0);
  });
});

describe("addStep", () => {
  it("appends input and expected to trajectory", () => {
    const traj = createTrajectory("test", { model: "gpt-4" });

    addStep(traj, { type: "user_message", content: "hi" }, {
      state: { status: "calling_model" },
      effects: ["call_model"],
    });

    expect(traj.inputs).toHaveLength(1);
    expect(traj.expected).toHaveLength(1);
    expect(traj.inputs[0]).toEqual({ type: "user_message", content: "hi" });
    expect(traj.expected[0]!.state.status).toBe("calling_model");
  });

  it("preserves multiple steps in order", () => {
    const traj = createTrajectory("test", { model: "gpt-4" });

    addStep(traj, { type: "user_message", content: "a" }, {
      state: { status: "calling_model" },
      effects: [],
    });
    addStep(traj, { type: "model_done", stopReason: "end_turn" }, {
      state: { status: "done" },
      effects: [],
    });

    expect(traj.inputs).toHaveLength(2);
    expect(traj.inputs[0]!.type).toBe("user_message");
    expect(traj.inputs[1]!.type).toBe("model_done");
  });
});
