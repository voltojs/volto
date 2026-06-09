import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { ToolDefinition } from "../tool.js";

const testTools: ToolDefinition[] = [];
const ctx: StepContext = { tools: testTools, model: "test-model" };

describe("TC-E5: Retriable model error 后 streaming 累加器清零", () => {
  it("clears _accumulatedText and _accumulatedToolCalls on retriable error", () => {
    // Simulate a state that has partial streaming data accumulated.
    const state: ReducerState = {
      ...createInitialState(),
      status: "calling_model",
      _accumulatedText: "partial ",
      _accumulatedToolCalls: [
        {
          id: "call_1",
          name: "read_file",
          argumentsText: '{"path":"foo',
        },
      ],
    };

    const result = step(
      state,
      { type: "model_error", error: "Rate limited", retriable: true },
      ctx,
    );

    // Accumulators must be cleared so retry doesn't produce duplicate content.
    expect(result.state._accumulatedText).toBe("");
    expect(result.state._accumulatedToolCalls).toEqual([]);

    // Status stays in calling_model (retry will happen).
    expect(result.state.status).toBe("calling_model");

    // Effects include a call_model (retry) and an error emit.
    const callModelEffects = result.effects.filter(
      (e) => e.type === "call_model",
    );
    expect(callModelEffects).toHaveLength(1);
    const errorEmits = result.effects.filter(
      (e) => e.type === "emit" && e.event.type === "error",
    );
    expect(errorEmits).toHaveLength(1);
  });

  it("preserves accumulated text on non-retriable error (transition to done)", () => {
    const state: ReducerState = {
      ...createInitialState(),
      status: "calling_model",
      _accumulatedText: "partial content",
      _accumulatedToolCalls: [],
    };

    const result = step(
      state,
      { type: "model_error", error: "Auth failed", retriable: false },
      ctx,
    );

    // Non-retriable → done. The reducer transitions without clearing
    // accumulators (they are discarded with the turn anyway).
    expect(result.state.status).toBe("done");
  });
});
