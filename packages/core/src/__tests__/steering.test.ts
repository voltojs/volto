/**
 * Phase 3 — steering (mid-turn user messages, queue + turn-boundary injection).
 *
 * Tests that user messages received during calling_model or executing_tools
 * are queued and injected at the next turn boundary, without interrupting
 * in-progress operations.
 */

import { describe, it, expect } from "vitest";
import { step, createInitialState, formatFileChangedNotice } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { AgentInput } from "../input.js";
import type { Effect } from "../effect.js";
import type { ToolDefinition } from "../tool.js";

const testTools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    requires: ["filesystem:read"],
    riskTier: "READ_ONLY",
  },
  {
    name: "bash",
    description: "Run a command",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    requires: ["shell:exec"],
    riskTier: "WRITE_LOW",
  },
];

const ctx: StepContext = { tools: testTools, model: "test-model", maxTokens: 4096 };

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function drive(
  inputs: AgentInput[],
  context: StepContext = ctx,
  initial?: ReducerState,
): Array<{ state: ReducerState; effects: Effect[] }> {
  const trace: Array<{ state: ReducerState; effects: Effect[] }> = [];
  let state = initial ?? createInitialState();
  for (const input of inputs) {
    const result = step(state, input, context);
    trace.push({ state: result.state, effects: result.effects });
    state = result.state;
  }
  return trace;
}

/** Build inputs that reach calling_model status (after user_message + model starts) */
function reachCallingModel(): AgentInput[] {
  return [
    { type: "user_message", content: "Do something" },
    { type: "model_chunk", chunk: { type: "text_delta", text: "Thinking..." } },
  ];
}

/** Build inputs that reach executing_tools with one pending tool */
function reachExecutingTools(): AgentInput[] {
  return [
    { type: "user_message", content: "Read the file" },
    {
      type: "model_chunk",
      chunk: {
        type: "tool_use_delta",
        toolCallId: "call_1",
        toolCallName: "read_file",
        argumentsDelta: '{"path":"foo.ts"}',
      },
    },
    { type: "model_done", stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } },
  ];
}

/** StepContext with an Id port so stamped message ids are real and distinct. */
function ctxWithIds(): StepContext {
  let n = 0;
  return { ...ctx, id: { next: () => `msg-${++n}` } };
}

/** Data of every emit effect of the given event type, in effects order. */
function emitData(effects: Effect[], type: string): Array<Record<string, unknown>> {
  return effects
    .filter((e): e is Extract<Effect, { type: "emit" }> => e.type === "emit" && e.event.type === type)
    .map((e) => e.event.data);
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("Phase 3 — steering", () => {
  describe("calling_model: user_message is queued", () => {
    it("should enqueue user_message during calling_model instead of throwing", () => {
      const setup = drive(reachCallingModel());
      const callingState = setup[setup.length - 1]!.state;
      expect(callingState.status).toBe("calling_model");

      // Inject a user message mid-stream
      const result = step(callingState, { type: "user_message", content: "Actually, also check bar.ts" }, ctx);

      expect(result.state.status).toBe("calling_model"); // Not changed
      expect(result.state.queuedUserInputs).toHaveLength(1);
      expect(result.state.queuedUserInputs[0]!.content).toBe("Actually, also check bar.ts");

      // Should emit a steering_queued event
      expect(result.effects.some((e) => e.type === "emit" && e.event.type === "steering_queued")).toBe(true);
    });

    it("queued user_message emits steering_queued carrying the stamped message id", () => {
      const context = ctxWithIds();
      const setup = drive(reachCallingModel(), context);
      const callingState = setup[setup.length - 1]!.state;

      const result = step(callingState, { type: "user_message", content: "Actually, also check bar.ts" }, context);

      const queued = result.state.queuedUserInputs[0]!;
      expect(queued.id).not.toBe("");
      expect(emitData(result.effects, "steering_queued")).toEqual([
        { id: queued.id, content: "Actually, also check bar.ts" },
      ]);
    });

    it("should queue multiple user messages", () => {
      const setup = drive(reachCallingModel());
      const callingState = setup[setup.length - 1]!.state;

      const r1 = step(callingState, { type: "user_message", content: "msg 1" }, ctx);
      const r2 = step(r1.state, { type: "user_message", content: "msg 2" }, ctx);

      expect(r2.state.queuedUserInputs).toHaveLength(2);
      expect(r2.state.queuedUserInputs[0]!.content).toBe("msg 1");
      expect(r2.state.queuedUserInputs[1]!.content).toBe("msg 2");
    });
  });

  describe("executing_tools: user_message is queued", () => {
    it("should enqueue user_message during executing_tools instead of throwing", () => {
      const setup = drive(reachExecutingTools());
      const execState = setup[setup.length - 1]!.state;
      expect(execState.status).toBe("executing_tools");

      // Inject a user message while tool is executing
      const result = step(execState, { type: "user_message", content: "Also edit bar.ts" }, ctx);

      expect(result.state.status).toBe("executing_tools"); // Not changed
      expect(result.state.queuedUserInputs).toHaveLength(1);
      expect(result.state.pendingTools).toHaveLength(1); // Pending tool still there
    });
  });

  describe("file_changed queued mid-turn", () => {
    it("queued file_changed notice emits steering_queued carrying the stamped message id", () => {
      const context = ctxWithIds();
      const setup = drive(reachCallingModel(), context);
      const callingState = setup[setup.length - 1]!.state;

      const input: Extract<AgentInput, { type: "file_changed" }> = {
        type: "file_changed",
        watchId: "watch-0",
        events: [{ type: "change", path: "src/app.ts" }],
      };
      const result = step(callingState, input, context);

      const queued = result.state.queuedUserInputs[0]!;
      expect(queued.id).not.toBe("");
      expect(emitData(result.effects, "steering_queued")).toEqual([
        { id: queued.id, content: formatFileChangedNotice(input) },
      ]);
    });
  });

  describe("turn boundary drain", () => {
    it("should drain queued messages into messages at turn boundary (tools complete)", () => {
      const setup = drive(reachExecutingTools());
      const execState = setup[setup.length - 1]!.state;

      // Queue a user message while executing
      const afterQueue = step(execState, { type: "user_message", content: "Queued message" }, ctx);
      expect(afterQueue.state.queuedUserInputs).toHaveLength(1);

      // Complete the tool → turn boundary → drain queue
      const afterTool = step(afterQueue.state, {
        type: "tool_result",
        toolCallId: "call_1",
        toolName: "read_file",
        result: { modelContent: "file content" },
      }, ctx);

      expect(afterTool.state.status).toBe("calling_model");
      expect(afterTool.state.queuedUserInputs).toHaveLength(0); // Queue cleared

      // The queued message should be in the messages array
      const lastMsg = afterTool.state.messages[afterTool.state.messages.length - 1];
      expect(lastMsg!.role).toBe("user");
      expect(lastMsg!.content).toBe("Queued message");

      // The call_model effect should include the queued message
      const callModelEffect = afterTool.effects.find((e) => e.type === "call_model");
      expect(callModelEffect).toBeDefined();
      const lastEffectMsg = callModelEffect!.request.messages[callModelEffect!.request.messages.length - 1];
      expect(lastEffectMsg!.role).toBe("user");
      expect(lastEffectMsg!.content).toBe("Queued message");
    });

    it("should maintain correct message order: [tool_results, queued_user_messages]", () => {
      const setup = drive(reachExecutingTools());
      const execState = setup[setup.length - 1]!.state;

      // Queue two messages
      const q1 = step(execState, { type: "user_message", content: "First queued" }, ctx);
      const q2 = step(q1.state, { type: "user_message", content: "Second queued" }, ctx);

      // Complete the tool
      const afterTool = step(q2.state, {
        type: "tool_result",
        toolCallId: "call_1",
        toolName: "read_file",
        result: { modelContent: "content" },
      }, ctx);

      // Messages should end with: tool_result, first_queued, second_queued
      const lastThree = afterTool.state.messages.slice(-3);
      expect(lastThree[0]!.role).toBe("tool");
      expect(lastThree[1]!.role).toBe("user");
      expect(lastThree[1]!.content).toBe("First queued");
      expect(lastThree[2]!.role).toBe("user");
      expect(lastThree[2]!.content).toBe("Second queued");
    });

    it("tool-batch flush emits steering_delivered with drained ids in FIFO order", () => {
      const context = ctxWithIds();
      const setup = drive(reachExecutingTools(), context);
      const execState = setup[setup.length - 1]!.state;

      const q1 = step(execState, { type: "user_message", content: "First queued" }, context);
      const q2 = step(q1.state, { type: "user_message", content: "Second queued" }, context);
      const id1 = q2.state.queuedUserInputs[0]!.id;
      const id2 = q2.state.queuedUserInputs[1]!.id;
      expect(id1).not.toBe("");
      expect(id2).not.toBe("");

      const afterTool = step(
        q2.state,
        {
          type: "tool_result",
          toolCallId: "call_1",
          toolName: "read_file",
          result: { modelContent: "file content" },
        },
        context,
      );

      expect(emitData(afterTool.effects, "steering_delivered")).toEqual([{ ids: [id1, id2] }]);
    });

    it("approval flush emits steering_delivered with drained ids", () => {
      const context = ctxWithIds();
      const setup = drive(reachExecutingTools(), context);
      const execState = setup[setup.length - 1]!.state;

      const q1 = step(execState, { type: "user_message", content: "First queued" }, context);
      const q2 = step(q1.state, { type: "user_message", content: "Second queued" }, context);
      const id1 = q2.state.queuedUserInputs[0]!.id;
      const id2 = q2.state.queuedUserInputs[1]!.id;
      expect(id1).not.toBe("");
      expect(id2).not.toBe("");

      const approval = step(q2.state, { type: "request_approval", toolCallId: "call_1" }, context);
      expect(approval.state.status).toBe("waiting_for_approval");

      const denied = step(
        approval.state,
        { type: "approval_decision", toolCallId: "call_1", decision: "deny" },
        context,
      );

      expect(emitData(denied.effects, "steering_delivered")).toEqual([{ ids: [id1, id2] }]);
    });

    it("flush with an empty queue emits no steering_delivered", () => {
      const context = ctxWithIds();
      const setup = drive(reachExecutingTools(), context);
      const execState = setup[setup.length - 1]!.state;
      expect(execState.queuedUserInputs).toHaveLength(0);

      const afterTool = step(
        execState,
        {
          type: "tool_result",
          toolCallId: "call_1",
          toolName: "read_file",
          result: { modelContent: "file content" },
        },
        context,
      );

      expect(emitData(afterTool.effects, "steering_delivered")).toEqual([]);
    });
  });

  describe("no interruption of in-progress tools", () => {
    it("queuing a message should not change pendingTools or tool execution state", () => {
      const setup = drive(reachExecutingTools());
      const execState = setup[setup.length - 1]!.state;
      const pendingBefore = [...execState.pendingTools];

      // Queue a message
      const afterQueue = step(execState, { type: "user_message", content: "Don't interrupt!" }, ctx);

      // Pending tools unchanged
      expect(afterQueue.state.pendingTools).toEqual(pendingBefore);
      expect(afterQueue.state.status).toBe("executing_tools");

      // Tool can still complete normally
      const afterTool = step(afterQueue.state, {
        type: "tool_result",
        toolCallId: "call_1",
        toolName: "read_file",
        result: { modelContent: "still works" },
      }, ctx);

      expect(afterTool.state.status).toBe("calling_model");
    });
  });

  describe("replay determinism with steering", () => {
    it("should produce identical final state when same steering inputs are replayed", () => {
      const inputs: AgentInput[] = [
        // Reach executing_tools
        ...reachExecutingTools(),
        // Steering message arrives mid-tool
        { type: "user_message", content: "Also check this" },
        // Tool completes
        {
          type: "tool_result",
          toolCallId: "call_1",
          toolName: "read_file",
          result: { modelContent: "file content" },
        },
      ];

      const trace1 = drive(inputs);
      const trace2 = drive(inputs);

      // Final states must be identical
      const final1 = trace1[trace1.length - 1]!;
      const final2 = trace2[trace2.length - 1]!;
      expect(final1.state).toEqual(final2.state);
      expect(final1.effects).toEqual(final2.effects);

      // Key invariant: queued message is in final messages
      const userMsgs = final1.state.messages.filter(
        (m) => m.role === "user" && m.content === "Also check this",
      );
      expect(userMsgs).toHaveLength(1);
    });
  });
});
