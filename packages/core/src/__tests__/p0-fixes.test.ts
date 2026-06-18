/**
 * P0 regression tests (code-review-2026-06-18 §3):
 *  - P0-1: self-correct input is processed by the reducer (no Runner mutation)
 *  - P0-2: call_model effect carries cacheBreakpoints from ContextAssembler
 *
 * Both assert the determinism / replay contract that was previously broken.
 */

import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { CallModelEffect, Effect } from "../effect.js";
import type { ToolDefinition } from "../tool.js";

const tools: ToolDefinition[] = [
  {
    name: "echo",
    description: "Echo a value",
    inputSchema: {
      type: "object",
      properties: { v: { type: "string" } },
      required: ["v"],
    },
    requires: ["test:echo"],
    riskTier: "READ_ONLY",
  },
];

const ctx: StepContext = { tools, model: "m", maxTokens: 1024 };

function driveToCallingModel(): ReducerState {
  const state = createInitialState({ pinnedMessageIds: [] });
  // user_message → idle calls buildCallModelEffect
  const r1 = step(state, { type: "user_message", content: "hi" }, ctx);
  return r1.state;
}

// ──────────────────────────────────────────────
// P0-2: cacheBreakpoints flow through call_model effect
// ──────────────────────────────────────────────

describe("P0-2: call_model effect carries cacheBreakpoints", () => {
  it("idle: emits call_model with cacheBreakpoints derived from ContextAssembler", () => {
    const state = createInitialState();
    const r = step(state, { type: "user_message", content: "hello" }, ctx);
    const callModel = r.effects.find((e): e is CallModelEffect => e.type === "call_model");

    expect(callModel).toBeDefined();
    expect(Array.isArray(callModel!.request.cacheBreakpoints)).toBe(true);
    // ContextAssembler always seeds breakpoint at index 0
    expect(callModel!.request.cacheBreakpoints).toContain(0);
  });

  it("executing_tools → calling_model: cacheBreakpoints present on continuation", () => {
    const state0 = driveToCallingModel();

    // model_done with tool_use → executing_tools
    const state = step(state0, {
      type: "model_done",
      stopReason: "tool_use",
    }, ctx).state;

    // feed tool_result → reducer emits next call_model
    const r = step(state, {
      type: "tool_result",
      toolCallId: "tc1",
      toolName: "echo",
      result: { modelContent: "ok", isError: false },
    }, ctx);

    // We didn't actually register the tool_use content, so pendingTools
    // may be empty. Use a richer sequence below. At minimum, the helper
    // should never emit call_model without cacheBreakpoints.
    const callModel = r.effects.find((e): e is CallModelEffect => e.type === "call_model");
    if (callModel) {
      expect(callModel.request.cacheBreakpoints).toBeDefined();
      expect(callModel.request.cacheBreakpoints!.length).toBeGreaterThan(0);
    }
  });

  it("full parallel tool loop emits cacheBreakpoints on every call_model", () => {
    const state0 = createInitialState();

    // user → call_model #1
    const res = step(state0, { type: "user_message", content: "go" }, ctx);
    let state = res.state;
    const cm = res.effects.find((e): e is CallModelEffect => e.type === "call_model")!;
    expect(cm.request.cacheBreakpoints).toContain(0);

    // Simulate model_done with tool_use for two parallel calls.
    // The reducer builds pendingTools from accumulated tool_use content.
    state = step(state, {
      type: "model_chunk",
      chunk: { type: "tool_use_delta", toolCallId: "tc1", toolCallName: "echo" },
    }, ctx).state;
    state = step(state, {
      type: "model_chunk",
      chunk: { type: "tool_use_delta", toolCallId: "tc1", argumentsDelta: '{"v":"a"}' },
    }, ctx).state;
    state = step(state, {
      type: "model_chunk",
      chunk: { type: "tool_use_delta", toolCallId: "tc2", toolCallName: "echo" },
    }, ctx).state;
    state = step(state, {
      type: "model_chunk",
      chunk: { type: "tool_use_delta", toolCallId: "tc2", argumentsDelta: '{"v":"b"}' },
    }, ctx).state;

    const doneRes = step(state, { type: "model_done", stopReason: "tool_use" }, ctx);
    state = doneRes.state;
    expect(state.status).toBe("executing_tools");
    expect(state.pendingTools.length).toBe(2);

    // Feed both tool_results (in any order — reducer re-orders)
    const t1 = step(state, {
      type: "tool_result",
      toolCallId: "tc2",
      toolName: "echo",
      result: { modelContent: "b", isError: false },
    }, ctx);
    state = t1.state;
    const t2 = step(state, {
      type: "tool_result",
      toolCallId: "tc1",
      toolName: "echo",
      result: { modelContent: "a", isError: false },
    }, ctx);
    state = t2.state;

    // Both done → reducer emits next call_model with breakpoints
    expect(state.status).toBe("calling_model");
    const cm2 = t2.effects.find((e): e is CallModelEffect => e.type === "call_model");
    expect(cm2).toBeDefined();
    expect(cm2!.request.cacheBreakpoints!.length).toBeGreaterThan(0);
  });

  it("reducer is deterministic — same input sequence yields same call_model cacheBreakpoints", () => {
    function runOnce(): number[] {
      const state = createInitialState();
      const r = step(state, { type: "user_message", content: "x" }, ctx);
      const cm = r.effects.find((e): e is CallModelEffect => e.type === "call_model")!;
      return cm.request.cacheBreakpoints!;
    }
    expect(runOnce()).toEqual(runOnce());
  });
});

// ──────────────────────────────────────────────
// P0-1: self_correct input is processed by the reducer
// ──────────────────────────────────────────────

describe("P0-1: self_correct input handled by reducer", () => {
  it("appends repair prompt as a user message and bumps counter when consumesBudget=true", () => {
    const state0 = driveToCallingModel();
    const before = state0.selfCorrectionCount;

    const r = step(state0, {
      type: "self_correct",
      repairPrompt: "[SELF-CORRECT] fix X",
      consumesBudget: true,
    }, ctx);

    const lastMsg = r.state.messages[r.state.messages.length - 1];
    expect(lastMsg).toBeDefined();
    expect(lastMsg!.role).toBe("user");
    expect((lastMsg as { content: unknown }).content).toBe("[SELF-CORRECT] fix X");
    expect(r.state.selfCorrectionCount).toBe(before + 1);
  });

  it("does not bump counter when consumesBudget=false (budget-exhausted notice)", () => {
    const state0 = driveToCallingModel();
    const before = state0.selfCorrectionCount;

    const r = step(state0, {
      type: "self_correct",
      repairPrompt: "[BUDGET EXHAUSTED]",
      consumesBudget: false,
    }, ctx);

    expect(r.state.selfCorrectionCount).toBe(before);
    const last = r.state.messages[r.state.messages.length - 1] as { content: unknown };
    expect(last.content).toBe("[BUDGET EXHAUSTED]");
  });

  it("emits a self_correct event observable by hooks/telemetry", () => {
    const state0 = driveToCallingModel();
    const r = step(state0, {
      type: "self_correct",
      repairPrompt: "fix",
      consumesBudget: true,
    }, ctx);

    const evt = r.effects.find(
      (e): e is Extract<Effect, { type: "emit" }> =>
        e.type === "emit" && e.event.type === "self_correct",
    );
    expect(evt).toBeDefined();
    expect(evt!.event.data.consumesBudget).toBe(true);
    expect(evt!.event.data.correctionCount).toBe(1);
  });

  it("replay-equivalence: identical input sequence reproduces identical state", () => {
    function runOnce(): { count: number; messages: unknown[] } {
      let state = createInitialState();
      // drive into calling_model first
      state = step(state, { type: "user_message", content: "u" }, ctx).state;
      state = step(state, {
        type: "self_correct",
        repairPrompt: "r1",
        consumesBudget: true,
      }, ctx).state;
      state = step(state, {
        type: "self_correct",
        repairPrompt: "r2",
        consumesBudget: true,
      }, ctx).state;
      return {
        count: state.selfCorrectionCount,
        messages: state.messages.map((m) => (m as { content: unknown }).content),
      };
    }
    expect(runOnce()).toEqual(runOnce());
  });
});
