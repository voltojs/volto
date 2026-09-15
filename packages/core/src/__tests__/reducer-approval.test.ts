import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { ToolDefinition } from "../tool.js";
import { userDenialMessage } from "../permission-policy.js";

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

  it("emits error when request_approval references unknown tool", () => {
    const state = stateWithPendingTools();
    const result = step(state, { type: "request_approval", toolCallId: "unknown" }, ctx);
    expect(result.state).toBe(state); // state unchanged
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]!.type).toBe("emit");
    expect((result.effects[0] as import("../effect.js").EmitEffect).event.type).toBe("error");
    expect((result.effects[0] as import("../effect.js").EmitEffect).event.data.error).toContain("not found in pendingTools");
  });

  it("allow decision moves tool back to pendingTools", () => {
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
    expect(r2.effects).toHaveLength(0);
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

  it("tells the model WHY a denial happened, not just that it did", () => {
    // The reason reaches the model, not only the UI. Told "the user denied
    // this", the model asks a follow-up question -- right when a human
    // clicked deny, useless when the connection dropped and nobody is there
    // to answer it. Observed live before this fix: the model replied
    // "命令执行被用户拒绝... 请确认是否允许执行该命令" to an empty room.
    function denialTextFor(reason?: "user" | "connection-lost" | "interrupted"): string {
      let state = stateWithPendingTools();
      state = step(state, { type: "request_approval", toolCallId: "t1" }, ctx).state;
      const result = step(
        state,
        {
          type: "approval_decision",
          toolCallId: "t1",
          decision: "deny",
          ...(reason !== undefined ? { reason } : {}),
        },
        ctx,
      );
      const lastMsg = result.state.messages[result.state.messages.length - 1]!;
      const block = (lastMsg as { content: Array<{ content: string }> }).content[0]!;
      return block.content;
    }

    // A dropped connection must not be attributed to the user, and must tell
    // the model to stop rather than ask.
    const lost = denialTextFor("connection-lost");
    expect(lost).toContain("connection dropped");
    expect(lost).not.toContain("by the user");
    expect(lost).toContain("do not ask for confirmation");

    const interrupted = denialTextFor("interrupted");
    expect(interrupted).toContain("interrupted");
    expect(interrupted).not.toContain("by the user");

    // A real user denial, and an absent reason, both produce the shared
    // userDenialMessage wording -- byte-identical, so a resumed transcript
    // (which synthesizes the same text) still matches the live history.
    expect(denialTextFor("user")).toBe(userDenialMessage("edit_file"));
    expect(denialTextFor()).toBe(userDenialMessage("edit_file"));
  });

  it("tells a user-denied model to stop rather than route around the refusal", () => {
    // The motivating failure: a refused git_push re-run through `bash`. On the
    // default preset (workspace-write + ask) an IRREVERSIBLE tool is asked
    // about, never policy-denied, so THIS is the only text the model sees.
    const text = userDenialMessage("git_push");
    expect(text).toContain("denied by the user");
    expect(text).toMatch(/do not use `bash`/i);
    expect(text).toMatch(/stop this line of work/i);
    // A user declining one call is not a configured boundary; do not send
    // them off to edit a permission setting.
    expect(text).not.toMatch(/permission setting/i);
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
    expect(r2.state.pendingApprovalTool).toBeUndefined();

    // t1 goes back onto the roster even though it will never execute: the
    // roster is what the completion path flushes in, so a denied tool left
    // off it loses its buffered message when t2 reports. t2 — the tool still
    // actually running — is untouched.
    expect(r2.state.pendingTools.map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(r2.state._toolResultBuffer["t1"]).toBeDefined();
  });

  it("emits error when approval_decision references wrong tool", () => {
    let state = stateWithPendingTools();
    const r1 = step(state, { type: "request_approval", toolCallId: "t1" }, ctx);
    state = r1.state;

    const result = step(state, { type: "approval_decision", toolCallId: "wrong-id", decision: "allow" }, ctx);
    expect(result.state).toBe(state); // state unchanged
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]!.type).toBe("emit");
    expect((result.effects[0] as import("../effect.js").EmitEffect).event.type).toBe("error");
    expect((result.effects[0] as import("../effect.js").EmitEffect).event.data.error).toContain("not found in pending approval");
  });

  it("cancel during waiting_for_approval transitions to cancelling", () => {
    let state = stateWithPendingTools();
    const r1 = step(state, { type: "request_approval", toolCallId: "t1" }, ctx);
    state = r1.state;

    const r2 = step(state, { type: "cancel", reason: "user abort" }, ctx);
    expect(r2.state.status).toBe("cancelling");
  });
});

// ──────────────────────────────────────────────
// Mixed batch: one tool denied, a sibling still executing
// ──────────────────────────────────────────────

const readTool: ToolDefinition = {
  name: "read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  requires: ["filesystem:read"],
  riskTier: "READ_ONLY",
};

const mixedCtx: StepContext = { tools: [writeTool, readTool], model: "test-model" };

/**
 * The Runner drains its approval queue before running the auto-allowed
 * parallel batch (runner.ts:788), so a batch containing one "ask" tool and
 * one "allow" tool produces exactly this input order.
 */
function mixedBatchState(): ReducerState {
  return createInitialState({
    status: "executing_tools",
    messages: [{ id: "m1", role: "user", content: "go" }],
    pendingTools: [
      { id: "c1", name: "edit_file", input: { path: "/a.ts" } },
      { id: "c2", name: "read_file", input: { path: "/b.ts" } },
    ],
  });
}

function toolResultIds(state: ReducerState): string[] {
  return state.messages
    .filter((m): m is Extract<typeof m, { role: "tool" }> => m.role === "tool")
    .flatMap((m) => m.content.map((b) => b.toolUseId));
}

describe("reducer: denial inside a mixed batch", () => {
  it("keeps the denied tool's message when a sibling reports afterwards", () => {
    let state = mixedBatchState();

    state = step(state, { type: "request_approval", toolCallId: "c1" }, mixedCtx).state;
    expect(state.status).toBe("waiting_for_approval");

    state = step(state, { type: "approval_decision", toolCallId: "c1", decision: "deny" }, mixedCtx).state;
    expect(state.status).toBe("executing_tools");

    const result = step(
      state,
      { type: "tool_result", toolCallId: "c2", toolName: "read_file", result: { modelContent: "b contents" } },
      mixedCtx,
    );

    // Both results must reach history. Losing the denial leaves the assistant's
    // tool_use block for c1 unanswered, which providers reject outright.
    expect(toolResultIds(result.state)).toEqual(expect.arrayContaining(["c1", "c2"]));
    expect(result.state.status).toBe("calling_model");
  });

  it("still flushes immediately when the denied tool is the only one", () => {
    let state = createInitialState({
      status: "executing_tools",
      messages: [{ id: "m3", role: "user", content: "go" }],
      pendingTools: [{ id: "c1", name: "edit_file", input: { path: "/a.ts" } }],
    });

    state = step(state, { type: "request_approval", toolCallId: "c1" }, mixedCtx).state;
    const result = step(state, { type: "approval_decision", toolCallId: "c1", decision: "deny" }, mixedCtx);

    expect(toolResultIds(result.state)).toEqual(["c1"]);
    expect(result.state.status).toBe("calling_model");
  });

  it("keeps both messages when every tool in the batch is denied", () => {
    let state = mixedBatchState();

    state = step(state, { type: "request_approval", toolCallId: "c1" }, mixedCtx).state;
    state = step(state, { type: "approval_decision", toolCallId: "c1", decision: "deny" }, mixedCtx).state;
    state = step(state, { type: "request_approval", toolCallId: "c2" }, mixedCtx).state;
    const result = step(state, { type: "approval_decision", toolCallId: "c2", decision: "deny" }, mixedCtx);

    expect(toolResultIds(result.state)).toEqual(expect.arrayContaining(["c1", "c2"]));
    expect(result.state.status).toBe("calling_model");
  });
});
