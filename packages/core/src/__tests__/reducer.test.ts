import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { AgentInput } from "../input.js";
import type { Effect } from "../effect.js";
import type { ToolDefinition } from "../tool.js";

// ──────────────────────────────────────────────
// Test fixtures
// ──────────────────────────────────────────────

const testTools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    requires: ["filesystem:read"],
    riskTier: "READ_ONLY",
  },
];

const ctx: StepContext = { tools: testTools, model: "test-model" };

function runChain(
  initialState: ReducerState,
  inputs: AgentInput[],
  context: StepContext = ctx,
): { finalState: ReducerState; allEffects: Effect[] } {
  let state = initialState;
  const allEffects: Effect[] = [];
  for (const input of inputs) {
    const result = step(state, input, context);
    state = result.state;
    allEffects.push(...result.effects);
  }
  return { finalState: state, allEffects };
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("step()", () => {
  describe("simple text conversation (no tools)", () => {
    it("should handle user message → model text → done", () => {
      const state = createInitialState();
      const inputs: AgentInput[] = [
        { type: "user_message", content: "Hello" },
        { type: "model_chunk", chunk: { type: "text_delta", text: "Hi there!" } },
        { type: "model_done", stopReason: "end_turn" },
      ];

      const { finalState, allEffects } = runChain(state, inputs);

      expect(finalState.status).toBe("done");
      expect(finalState.messages).toHaveLength(2); // user + assistant
      expect(finalState.messages[0]).toMatchObject({ role: "user", content: "Hello" });
      expect(finalState.messages[1]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
        stopReason: "end_turn",
      });

      // Should have: call_model, emit(user_message), emit(text_delta), emit(model_done), done
      const callModelEffects = allEffects.filter((e) => e.type === "call_model");
      const doneEffects = allEffects.filter((e) => e.type === "done");
      expect(callModelEffects).toHaveLength(1);
      expect(doneEffects).toHaveLength(1);
    });

    it("should accumulate multiple text chunks", () => {
      const state = createInitialState();
      const inputs: AgentInput[] = [
        { type: "user_message", content: "Hi" },
        { type: "model_chunk", chunk: { type: "text_delta", text: "Hello " } },
        { type: "model_chunk", chunk: { type: "text_delta", text: "world!" } },
        { type: "model_done", stopReason: "end_turn" },
      ];

      const { finalState } = runChain(state, inputs);
      const assistant = finalState.messages[1];
      expect(assistant).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Hello world!" }],
      });
    });
  });

  describe("tool use chain", () => {
    it("should handle full tool use loop: user → model(tool_use) → execute → result → model(text) → done", () => {
      const state = createInitialState();
      const inputs: AgentInput[] = [
        // User asks to read a file
        { type: "user_message", content: "Read foo.ts" },
        // Model responds with tool_use
        { type: "model_chunk", chunk: { type: "text_delta", text: "Let me read that file." } },
        {
          type: "model_chunk",
          chunk: {
            type: "tool_use_delta",
            toolCallId: "call_1",
            toolCallName: "read_file",
            argumentsDelta: '{"path":"foo.ts"}',
          },
        },
        { type: "model_done", stopReason: "tool_use" },
        // Runner executes tool, feeds result back
        {
          type: "tool_result",
          toolCallId: "call_1",
          toolName: "read_file",
          result: { modelContent: "const x = 1;", isError: false },
        },
        // Model responds with final text
        { type: "model_chunk", chunk: { type: "text_delta", text: "The file contains: const x = 1;" } },
        { type: "model_done", stopReason: "end_turn" },
      ];

      const { finalState, allEffects } = runChain(state, inputs);

      expect(finalState.status).toBe("done");
      expect(finalState.messages).toHaveLength(4); // user, assistant(tool_use), tool_result, assistant(text)

      // Messages structure
      expect(finalState.messages[0]).toMatchObject({ role: "user" });
      expect(finalState.messages[1]).toMatchObject({
        role: "assistant",
        stopReason: "tool_use",
        content: expect.arrayContaining([
          { type: "text", text: "Let me read that file." },
          { type: "tool_use", id: "call_1", name: "read_file", input: { path: "foo.ts" } },
        ]),
      });
      expect(finalState.messages[2]).toMatchObject({ role: "tool" });
      expect(finalState.messages[3]).toMatchObject({ role: "assistant", stopReason: "end_turn" });

      // Should have 2 call_model effects (before tool, after tool)
      const callModelEffects = allEffects.filter((e) => e.type === "call_model");
      expect(callModelEffects).toHaveLength(2);
    });

    it("should handle multiple parallel tool calls", () => {
      const state = createInitialState();
      const inputs: AgentInput[] = [
        { type: "user_message", content: "Read both files" },
        {
          type: "model_chunk",
          chunk: { type: "tool_use_delta", toolCallId: "call_1", toolCallName: "read_file", argumentsDelta: '{"path":"a.ts"}' },
        },
        {
          type: "model_chunk",
          chunk: { type: "tool_use_delta", toolCallId: "call_2", toolCallName: "read_file", argumentsDelta: '{"path":"b.ts"}' },
        },
        { type: "model_done", stopReason: "tool_use" },
        // Results come back one by one
        {
          type: "tool_result",
          toolCallId: "call_1",
          toolName: "read_file",
          result: { modelContent: "file a content" },
        },
        {
          type: "tool_result",
          toolCallId: "call_2",
          toolName: "read_file",
          result: { modelContent: "file b content" },
        },
        // Model final response
        { type: "model_chunk", chunk: { type: "text_delta", text: "Both files read." } },
        { type: "model_done", stopReason: "end_turn" },
      ];

      const { finalState } = runChain(state, inputs);
      expect(finalState.status).toBe("done");
      expect(finalState.messages).toHaveLength(5); // user, assistant(2 tool_use), tool(a), tool(b), assistant(text)
    });
  });

  describe("error handling", () => {
    it("should handle retriable model error by staying in calling_model", () => {
      const state = createInitialState();
      const inputs: AgentInput[] = [
        { type: "user_message", content: "Hi" },
        { type: "model_error", error: "Rate limited", retriable: true },
      ];

      const { finalState, allEffects } = runChain(state, inputs);
      expect(finalState.status).toBe("calling_model");
      const callModelEffects = allEffects.filter((e) => e.type === "call_model");
      expect(callModelEffects).toHaveLength(2); // initial + retry
    });

    it("should handle non-retriable model error by transitioning to done", () => {
      const state = createInitialState();
      const inputs: AgentInput[] = [
        { type: "user_message", content: "Hi" },
        { type: "model_error", error: "Auth failed", retriable: false },
      ];

      const { finalState } = runChain(state, inputs);
      expect(finalState.status).toBe("done");
    });

    it("should handle tool error result (isError: true) and continue loop", () => {
      const state = createInitialState();
      const inputs: AgentInput[] = [
        { type: "user_message", content: "Read missing.ts" },
        {
          type: "model_chunk",
          chunk: { type: "tool_use_delta", toolCallId: "call_1", toolCallName: "read_file", argumentsDelta: '{"path":"missing.ts"}' },
        },
        { type: "model_done", stopReason: "tool_use" },
        {
          type: "tool_result",
          toolCallId: "call_1",
          toolName: "read_file",
          result: { modelContent: "File not found", isError: true },
        },
        { type: "model_chunk", chunk: { type: "text_delta", text: "Sorry, the file doesn't exist." } },
        { type: "model_done", stopReason: "end_turn" },
      ];

      const { finalState } = runChain(state, inputs);
      expect(finalState.status).toBe("done");
      // The tool result message should be marked as error
      const toolMsg = finalState.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content[0]).toMatchObject({ isError: true });
    });
  });

  describe("max iterations", () => {
    it("should stop after maxIterations with max_tokens stop reason", () => {
      const state = createInitialState({ maxIterations: 2 });
      const inputs: AgentInput[] = [
        { type: "user_message", content: "Hi" },
        { type: "model_done", stopReason: "max_tokens" }, // iteration 1
        { type: "model_done", stopReason: "max_tokens" }, // iteration 2 = max
      ];

      const { finalState, allEffects } = runChain(state, inputs);
      expect(finalState.status).toBe("done");
      const errorEmit = allEffects.find((e) => e.type === "emit" && e.event.type === "error");
      expect(errorEmit).toBeDefined();
    });

    it("should stop a runaway tool_use loop once maxIterations is reached", () => {
      const state = createInitialState({ maxIterations: 2 });
      // Model keeps asking to call tools forever; guard must terminate the loop.
      const toolUseChunk: AgentInput = {
        type: "model_chunk",
        chunk: { type: "tool_use_delta", toolCallId: "call_1", toolCallName: "read_file", argumentsDelta: '{"path":"a.ts"}' },
      };
      const inputs: AgentInput[] = [
        { type: "user_message", content: "loop forever" },
        toolUseChunk,
        { type: "model_done", stopReason: "tool_use" }, // iteration 1 → executing_tools
        { type: "tool_result", toolCallId: "call_1", toolName: "read_file", result: { modelContent: "x" } },
        toolUseChunk,
        { type: "model_done", stopReason: "tool_use" }, // iteration 2 = max → must stop, no tools dispatched
      ];

      const { finalState, allEffects } = runChain(state, inputs);
      expect(finalState.status).toBe("done");
      expect(finalState.pendingTools).toHaveLength(0);
      const errorEmit = allEffects.find((e) => e.type === "emit" && e.event.type === "error");
      expect(errorEmit).toBeDefined();
      // Done effect emitted, loop terminated.
      expect(allEffects.filter((e) => e.type === "done")).toHaveLength(1);
    });
  });

  describe("token budget", () => {
    it("should accumulate usage and stop the tool_use loop when tokenBudget is exceeded", () => {
      const state = createInitialState({ tokenBudget: 100, maxIterations: 50 });
      const inputs: AgentInput[] = [
        { type: "user_message", content: "expensive" },
        {
          type: "model_chunk",
          chunk: { type: "tool_use_delta", toolCallId: "call_1", toolCallName: "read_file", argumentsDelta: '{"path":"a.ts"}' },
        },
        // 120 tokens > budget of 100 → next continuation must be blocked
        { type: "model_done", stopReason: "tool_use", usage: { inputTokens: 80, outputTokens: 40 } },
      ];

      const { finalState, allEffects } = runChain(state, inputs);
      expect(finalState.status).toBe("done");
      expect(finalState.tokensUsed).toBe(120);
      expect(finalState.pendingTools).toHaveLength(0);
      const errorEmit = allEffects.find(
        (e) => e.type === "emit" && e.event.type === "error" && e.event.data.error === "Token budget exceeded",
      );
      expect(errorEmit).toBeDefined();
    });

    it("should allow the loop to continue while under tokenBudget", () => {
      const state = createInitialState({ tokenBudget: 1000 });
      const inputs: AgentInput[] = [
        { type: "user_message", content: "cheap" },
        {
          type: "model_chunk",
          chunk: { type: "tool_use_delta", toolCallId: "call_1", toolCallName: "read_file", argumentsDelta: '{"path":"a.ts"}' },
        },
        { type: "model_done", stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } },
      ];

      const { finalState } = runChain(state, inputs);
      expect(finalState.status).toBe("executing_tools");
      expect(finalState.tokensUsed).toBe(15);
      expect(finalState.pendingTools).toHaveLength(1);
    });
  });

  describe("cancel", () => {
    it("should transition to cancelling from calling_model", () => {
      const state = createInitialState();
      const inputs: AgentInput[] = [
        { type: "user_message", content: "Hi" },
        { type: "cancel", reason: "user abort" },
      ];

      const { finalState } = runChain(state, inputs);
      expect(finalState.status).toBe("cancelling");
    });

    it("should transition from cancelling to done on second cancel", () => {
      const state = createInitialState({ status: "cancelling" });
      const result = step(state, { type: "cancel" }, ctx);
      expect(result.state.status).toBe("done");
      expect(result.effects).toContainEqual({ type: "done" });
    });
  });

  describe("invalid transitions", () => {
    it("should emit error on unexpected input type for current status", () => {
      const state = createInitialState();
      const result = step(state, { type: "model_chunk", chunk: { type: "text_delta", text: "hi" } }, ctx);
      expect(result.state).toBe(state); // state unchanged
      expect(result.effects).toHaveLength(1);
      expect(result.effects[0]!.type).toBe("emit");
      expect((result.effects[0] as import("../effect.js").EmitEffect).event.type).toBe("error");
      expect((result.effects[0] as import("../effect.js").EmitEffect).event.data.error).toContain("idle: unexpected input type");
    });

    it("should emit error when called on done state", () => {
      const state = createInitialState({ status: "done" });
      const result = step(state, { type: "cancel" }, ctx);
      expect(result.state).toBe(state); // state unchanged
      expect(result.effects).toHaveLength(1);
      expect(result.effects[0]!.type).toBe("emit");
      expect((result.effects[0] as import("../effect.js").EmitEffect).event.type).toBe("error");
      expect((result.effects[0] as import("../effect.js").EmitEffect).event.data.error).toContain("done state");
    });
  });
});
