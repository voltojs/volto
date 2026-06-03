import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import type { ToolExecutor } from "../runner.js";
import {
  createMockModelPort,
  textDelta,
  toolUseStart,
  toolUseDelta,
  usage,
  modelDone,
  modelError,
  toolCallScript,
  textScript,
} from "@agent-core/core";
import type { StepContext, ToolDefinition, PendingToolCall, ToolResult, EventSink } from "@agent-core/core";

// ──────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────

const readTool: ToolDefinition = {
  name: "read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  requires: ["filesystem:read"],
  riskTier: "READ_ONLY",
};

const ctx: StepContext = { tools: [readTool], model: "test-model" };

function createMockToolExecutor(results: Record<string, ToolResult>): ToolExecutor {
  return async (call: PendingToolCall): Promise<ToolResult> => {
    const result = results[call.name];
    if (!result) {
      return { modelContent: `Unknown tool: ${call.name}`, isError: true };
    }
    return result;
  };
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("Runner", () => {
  describe("simple text conversation (no tools)", () => {
    it("should run a complete user → model text → done cycle", async () => {
      const mockModel = createMockModelPort([
        [textDelta("Hello, world!"), modelDone("end_turn")],
      ]);

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
      });

      const finalState = await runner.run({ type: "user_message", content: "Hi" });

      expect(finalState.status).toBe("done");
      expect(finalState.messages).toHaveLength(2);
      expect(finalState.messages[0]).toMatchObject({ role: "user", content: "Hi" });
      expect(finalState.messages[1]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Hello, world!" }],
        stopReason: "end_turn",
      });
    });

    it("should accumulate multiple text chunks", async () => {
      const mockModel = createMockModelPort([
        [textDelta("Hello "), textDelta("world!"), modelDone("end_turn")],
      ]);

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
      });

      const finalState = await runner.run({ type: "user_message", content: "Hi" });

      expect(finalState.messages[1]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Hello world!" }],
      });
    });

    it("should report usage from model events", async () => {
      const mockModel = createMockModelPort([
        [textDelta("Hi"), usage(100, 50), modelDone("end_turn")],
      ]);

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
      });

      const finalState = await runner.run({ type: "user_message", content: "Hello" });

      expect(finalState.tokensUsed).toBe(150);
    });
  });

  describe("tool use cycle", () => {
    it("should run full tool use loop: user → model(tool_use) → execute → model(text) → done", async () => {
      const mockModel = createMockModelPort([
        // First call: model wants to use a tool
        toolCallScript("call_1", "read_file", '{"path":"foo.ts"}'),
        // Second call: model responds with text after seeing tool result
        textScript("The file contains: const x = 1;"),
      ]);

      const toolExecutor = createMockToolExecutor({
        read_file: { modelContent: "const x = 1;", isError: false },
      });

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
        toolExecutor,
      });

      const finalState = await runner.run({ type: "user_message", content: "Read foo.ts" });

      expect(finalState.status).toBe("done");
      expect(finalState.messages).toHaveLength(4); // user, assistant(tool_use), tool_result, assistant(text)
      expect(finalState.messages[0]).toMatchObject({ role: "user" });
      expect(finalState.messages[1]).toMatchObject({ role: "assistant", stopReason: "tool_use" });
      expect(finalState.messages[2]).toMatchObject({ role: "tool" });
      expect(finalState.messages[3]).toMatchObject({ role: "assistant", stopReason: "end_turn" });
      expect(mockModel.callCount).toBe(2); // Two model calls
    });

    it("should handle multiple parallel tool calls", async () => {
      const mockModel = createMockModelPort([
        // Model requests two tool calls
        [
          toolUseStart("call_1", "read_file"),
          toolUseDelta("call_1", '{"path":"a.ts"}'),
          toolUseStart("call_2", "read_file"),
          toolUseDelta("call_2", '{"path":"b.ts"}'),
          modelDone("tool_use"),
        ],
        textScript("Both files read."),
      ]);

      const toolExecutor = createMockToolExecutor({
        read_file: { modelContent: "file content" },
      });

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
        toolExecutor,
      });

      const finalState = await runner.run({ type: "user_message", content: "Read both files" });

      expect(finalState.status).toBe("done");
      expect(finalState.messages).toHaveLength(5); // user, assistant(2 tool_use), tool(a), tool(b), assistant(text)
    });

    it("should feed tool error results back to the model", async () => {
      const mockModel = createMockModelPort([
        toolCallScript("call_1", "read_file", '{"path":"missing.ts"}'),
        textScript("The file doesn't exist."),
      ]);

      const toolExecutor = createMockToolExecutor({
        read_file: { modelContent: "File not found", isError: true },
      });

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
        toolExecutor,
      });

      const finalState = await runner.run({ type: "user_message", content: "Read missing.ts" });

      expect(finalState.status).toBe("done");
      const toolMsg = finalState.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content[0]).toMatchObject({ isError: true });
    });

    it("should handle tool executor throwing an exception", async () => {
      const mockModel = createMockModelPort([
        toolCallScript("call_1", "read_file", '{"path":"bad.ts"}'),
        textScript("Got an error."),
      ]);

      const toolExecutor: ToolExecutor = async () => {
        throw new Error("Disk failure");
      };

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
        toolExecutor,
      });

      const finalState = await runner.run({ type: "user_message", content: "Read bad.ts" });

      expect(finalState.status).toBe("done");
      const toolMsg = finalState.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content[0]).toMatchObject({
        content: expect.stringContaining("Disk failure"),
        isError: true,
      });
    });

    it("should report missing tool executor as error result", async () => {
      const mockModel = createMockModelPort([
        toolCallScript("call_1", "read_file", '{"path":"test.ts"}'),
        textScript("Okay."),
      ]);

      // No toolExecutor provided
      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
      });

      const finalState = await runner.run({ type: "user_message", content: "Read test.ts" });

      const toolMsg = finalState.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content[0]).toMatchObject({ isError: true });
    });
  });

  describe("cancellation", () => {
    it("should cancel during model streaming when AbortSignal fires", async () => {
      const ac = new AbortController();

      // Create a model port that yields events slowly
      const mockModel = createMockModelPort([
        [textDelta("Hello"), textDelta(" world"), textDelta("!"), modelDone("end_turn")],
      ]);

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
        abortSignal: ac.signal,
      });

      // Abort immediately — the runner should handle this gracefully
      ac.abort();

      const finalState = await runner.run({ type: "user_message", content: "Hi" });

      // Should be in done state (cancelled → done)
      expect(finalState.status).toBe("done");
    });

    it("should cancel between tool calls when AbortSignal fires", async () => {
      const ac = new AbortController();

      const mockModel = createMockModelPort([
        toolCallScript("call_1", "read_file", '{"path":"a.ts"}'),
      ]);

      const toolExecutor: ToolExecutor = async (call) => {
        // Abort during tool execution
        ac.abort();
        return { modelContent: `Executed ${call.name}` };
      };

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
        toolExecutor,
        abortSignal: ac.signal,
      });

      const finalState = await runner.run({ type: "user_message", content: "Read file" });

      // Should eventually reach done state
      expect(finalState.status).toBe("done");
    });

    it("should handle already-aborted signal", async () => {
      const ac = new AbortController();
      ac.abort();

      const mockModel = createMockModelPort([
        textScript("Should not reach here"),
      ]);

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
        abortSignal: ac.signal,
      });

      const finalState = await runner.run({ type: "user_message", content: "Hi" });

      expect(finalState.status).toBe("done");
    });
  });

  describe("model error handling", () => {
    it("should handle retriable model error and retry", async () => {
      const mockModel = createMockModelPort([
        [modelError("Rate limited", true)],
        textScript("Success after retry!"),
      ]);

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
      });

      const finalState = await runner.run({ type: "user_message", content: "Hi" });

      expect(finalState.status).toBe("done");
      expect(finalState.messages).toHaveLength(2);
      expect(finalState.messages[1]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Success after retry!" }],
      });
    });

    it("should handle non-retriable model error and terminate", async () => {
      const mockModel = createMockModelPort([
        [modelError("Auth failed", false)],
      ]);

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
      });

      const finalState = await runner.run({ type: "user_message", content: "Hi" });

      expect(finalState.status).toBe("done");
    });
  });

  describe("event sink integration", () => {
    it("should forward emit effects to EventSink", async () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const eventSink: EventSink = {
        emit(event) { events.push(event); },
      };

      const mockModel = createMockModelPort([
        [textDelta("Hello"), modelDone("end_turn")],
      ]);





      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
        eventSink,
      });

      await runner.run({ type: "user_message", content: "Hi" });

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("user_message");
      expect(eventTypes).toContain("text_delta");
      expect(eventTypes).toContain("model_done");
    });
  });

  describe("getState", () => {
    it("should expose current state during execution", async () => {
      const mockModel = createMockModelPort([
        textScript("Done."),
      ]);

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
      });

      const initialState = runner.getState();
      expect(initialState.status).toBe("idle");

      await runner.run({ type: "user_message", content: "Hi" });

      const finalState = runner.getState();
      expect(finalState.status).toBe("done");
    });
  });
});
