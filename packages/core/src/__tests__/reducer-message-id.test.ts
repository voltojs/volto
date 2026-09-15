import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { StepContext, ReducerState } from "../reducer.js";
import type { Id } from "../ports.js";
import type { ToolDefinition } from "../tool.js";

function seqId(): Id {
  let n = 0;
  return { next: () => `id-${++n}` };
}

const ctx: StepContext = { tools: [], model: "m", id: seqId() };
const bare: StepContext = { tools: [], model: "m" };

const tools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    requires: ["filesystem:read"],
    riskTier: "READ_ONLY",
  },
];

const toolCtx: StepContext = { tools, model: "m", id: seqId() };

/** Drive user_message → tool_use model stream → tool_use stop. */
function toExecutingTools(context: StepContext): ReducerState {
  let state = createInitialState();
  state = step(state, { type: "user_message", content: "go" }, context).state;
  state = step(
    state,
    {
      type: "model_chunk",
      chunk: { type: "tool_use_delta", toolCallId: "c1", toolCallName: "read_file", argumentsDelta: '{"path":"a.ts"}' },
    },
    context,
  ).state;
  state = step(state, { type: "model_done", stopReason: "tool_use" }, context).state;
  expect(state.status).toBe("executing_tools");
  return state;
}

/** Drive a full user → assistant(text) turn. */
function toDone(context: StepContext): ReducerState {
  let state = createInitialState();
  state = step(state, { type: "user_message", content: "hi" }, context).state;
  state = step(state, { type: "model_chunk", chunk: { type: "text_delta", text: "hello" } }, context).state;
  state = step(state, { type: "model_done", stopReason: "end_turn" }, context).state;
  expect(state.status).toBe("done");
  return state;
}

function lastId(state: ReducerState): string {
  const msg = state.messages[state.messages.length - 1];
  if (!msg) throw new Error("no messages");
  return msg.id;
}

describe("message ids", () => {
  it("stamps every appended message with an id from StepContext.id", () => {
    let state = createInitialState();
    const r1 = step(state, { type: "user_message", content: "hi" }, ctx);
    state = r1.state;
    expect(state.messages.every((m) => typeof m.id === "string" && m.id.length > 0)).toBe(true);
    const ids = state.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("leaves the construction placeholder id when StepContext.id is absent", () => {
    const r = step(createInitialState(), { type: "user_message", content: "hi" }, bare);
    expect(r.state.messages.length).toBeGreaterThan(0);
    // Without an Id port the reducer must not invent one — the user message
    // keeps the construction-time placeholder, which is the empty string.
    const user = r.state.messages.find((m) => m.role === "user");
    expect(user).toBeDefined();
    expect(user!.id).toBe("");
  });

  it("stamps the assistant message on model_done", () => {
    const state = toDone(ctx);
    const assistant = state.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.id.length).toBeGreaterThan(0);
    expect(assistant!.id).not.toBe(state.messages[0]!.id);
  });

  it("leaves the assistant placeholder when StepContext.id is absent", () => {
    const state = toDone(bare);
    const assistant = state.messages.find((m) => m.role === "assistant");
    expect(assistant!.id).toBe("");
  });

  it("stamps a tool result message", () => {
    let state = toExecutingTools(toolCtx);
    const before = state.messages.map((m) => m.id);
    state = step(
      state,
      {
        type: "tool_result",
        toolCallId: "c1",
        toolName: "read_file",
        result: { modelContent: "contents" },
      },
      toolCtx,
    ).state;
    const tool = state.messages.find((m) => m.role === "tool");
    expect(tool).toBeDefined();
    expect(tool!.id.length).toBeGreaterThan(0);
    expect(before).not.toContain(tool!.id);
  });

  it("stamps a self_correct repair message", () => {
    // self_correct is accepted in any active state; use calling_model.
    let state = createInitialState();
    state = step(state, { type: "user_message", content: "hi" }, ctx).state;
    expect(state.status).toBe("calling_model");
    const before = state.messages.map((m) => m.id);
    state = step(
      state,
      { type: "self_correct", repairPrompt: "fix the JSON", consumesBudget: false },
      ctx,
    ).state;
    expect(lastId(state)).not.toBe("");
    expect(before).not.toContain(lastId(state));
    const repair = state.messages[state.messages.length - 1]!;
    expect(repair.role).toBe("user");
  });

  it("stamps a steering-queued user message", () => {
    let state = createInitialState();
    state = step(state, { type: "user_message", content: "hi" }, ctx).state;
    // Mid-turn steering: user_message while calling_model → queued.
    const r = step(state, { type: "user_message", content: "wait, also…" }, ctx);
    expect(r.state.queuedUserInputs).toHaveLength(1);
    expect(r.state.queuedUserInputs[0]!.id.length).toBeGreaterThan(0);
  });

  it("stamps an approval-denied tool result", () => {
    let state = toExecutingTools(toolCtx);
    state = step(state, { type: "request_approval", toolCallId: "c1" }, toolCtx).state;
    expect(state.status).toBe("waiting_for_approval");
    state = step(
      state,
      { type: "approval_decision", toolCallId: "c1", decision: "deny" },
      toolCtx,
    ).state;
    const tool = state.messages.find((m) => m.role === "tool");
    expect(tool).toBeDefined();
    expect(tool!.id.length).toBeGreaterThan(0);
  });

  it("does not re-stamp messages that were already in state", () => {
    const state1 = toDone(ctx);
    const idsBefore = state1.messages.map((m) => m.id);
    // Feed another turn against a fresh id port — prior messages keep their ids.
    const nextCtx: StepContext = { tools: [], model: "m", id: seqId() };
    let state2 = step(
      { ...state1, status: "idle" },
      { type: "user_message", content: "again" },
      nextCtx,
    ).state;
    const priorIds = state2.messages.slice(0, idsBefore.length).map((m) => m.id);
    expect(priorIds).toEqual(idsBefore);
  });
});
