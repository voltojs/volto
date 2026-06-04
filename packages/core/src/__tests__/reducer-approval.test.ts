import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { ToolDefinition } from "../tool.js";

const writeTool: ToolDefinition = {
  name: "edit_file",
  description: "Edit a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  requires: ["filesystem:write"],
  riskTier: "WRITE_HIGH",
};

const ctx: StepContext = {
  tools: [writeTool],
  model: "test-model",
};

function stateWithPendingTools(): ReducerState {
  return createInitialState({
    status: "executing_tools",
    pendingTools: [{ id: "t1", name: "edit_file", input: { path: "/a.ts" } }],
  });
}

describe("reducer: request_approval flow", () => {
  it("transitions from executing_tools to waiting_for_approval on request_approval", () => {
    const state = stateWithPendingTools();
    const result = step(state, { type: "request_approval", toolCallId: "t1" }, ctx);

    expect(result.state.status).toBe("waiting_for_approval");
    expect(result.state.pendingTools).toHaveLength(0);
    expect(result.state.pendingApprovalTool).toBeDefined();
    expect(result.state.pendingApprovalTool!.id).toBe("t1");
    expect(result.state.pendingApprovalTool!.name).toBe("edit_file");
    expect(result.effects).toHaveLength(2);
    expect(result.effects[0]!.type).toBe("request_approval");
    expect(result.effects[1]!.type).toBe("checkpoint");
  });

  it("throws when request_approval references unknown tool", () => {
    const state = stateWithPendingTools();
    expect(() =>
      step(state, { type: "request_approval", toolCallId: "unknown" }, ctx),
    ).toThrow('not found in pendingTools');
  });

  it("allow decision moves tool back to pendingTools and emits execute_tool", () => {
    let state = stateWithPendingTools();
    // request_approval → waiting_for_approval
    const r1 = step(state, { type: "request_approval", toolCallId: "t1" }, ctx);
    state = r1.state;

    expect(state.status).toBe("waiting_for_approval");
    expect(state.pendingApprovalTool!.id).toBe("t1");

    // approval_decision → allow
    const r2 = step(state, { type: "approval_decision", toolCallId: "t1", decision: "allow" }, ctx);
    state = r2.state;

    expect(state.status).toBe("executing_tools");
    expect(state.pendingTools).toHaveLength(1);
    expect(state.pendingTools[0]!.id).toBe("t1");
    expect(state.pendingApprovalTool).toBeUndefined();
    expect(r2.effects).toHaveLength(1);
    expect(r2.effects[0]!.type).toBe("execute_tool");
  });

  it("deny decision creates error result and clears pending approval tool", () => {
    let state = stateWithPendingTools();
    const r1 = step(state, { type: "request_approval", toolCallId: "t1" }, ctx);
    state = r1.state;

    // approval_decision → deny (no remaining tools)
    const r2 = step(state, { type: "approval_decision", toolCallId: "t1", decision: "deny" }, ctx);
    state = r2.state;

    expect(state.status).toBe("calling_model");
    expect(state.pendingTools).toHaveLength(0);
    expect(state.pendingApprovalTool).toBeUndefined();
    // Should have the denial message in messages
    const lastMsg = state.messages[state.messages.length - 1]!;
    expect(lastMsg.role).toBe("tool");
  });

  it("deny with remaining tools continues executing_tools", () => {
    const state: ReducerState = createInitialState({
      status: "executing_tools",
      pendingTools: [
        { id: "t1", name: "edit_file", input: { path: "/a.ts" } },
        { id: "t2", name: "edit_file", input: { path: "/b.ts" } },
      ],
    });

    // request_approval for t1
    const r1 = step(state, { type: "request_approval", toolCallId: "t1" }, ctx);
    expect(r1.state.status).toBe("waiting_for_approval");
    expect(r1.state.pendingTools).toHaveLength(1);
    expect(r1.state.pendingTools[0]!.id).toBe("t2");

    // deny t1
    const r2 = step(r1.state, { type: "approval_decision", toolCallId: "t1", decision: "deny" }, ctx);
    expect(r2.state.status).toBe("executing_tools");
    expect(r2.state.pendingTools).toHaveLength(1);
    expect(r2.state.pendingTools[0]!.id).toBe("t2");
    expect(r2.state.pendingApprovalTool).toBeUndefined();
  });

  it("throws when approval_decision references wrong tool", () => {
    let state = stateWithPendingTools();
    const r1 = step(state, { type: "request_approval", toolCallId: "t1" }, ctx);
    state = r1.state;

    expect(() =>
      step(state, { type: "approval_decision", toolCallId: "wrong-id", decision: "allow" }, ctx),
    ).toThrow("not found in pending approval");
  });

  it("cancel during waiting_for_approval transitions to cancelling", () => {
    let state = stateWithPendingTools();
    const r1 = step(state, { type: "request_approval", toolCallId: "t1" }, ctx);
    state = r1.state;

    const r2 = step(state, { type: "cancel", reason: "user abort" }, ctx);
    expect(r2.state.status).toBe("cancelling");
  });
});
