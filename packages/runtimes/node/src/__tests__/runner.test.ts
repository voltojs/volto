import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import type { ToolExecutor } from "../runner.js";
import {
  createMockModelPort,
  textDelta,
  reasoningDelta,
  toolUseStart,
  toolUseDelta,
  usage,
  modelDone,
  modelError,
  toolCallScript,
  textScript,
} from "@volto/core";
import type { StepContext, ToolDefinition, PendingToolCall, ToolResult, EventSink, Hook, TranscriptEventInput } from "@volto/core";

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
const capabilities = new Set(["filesystem:read"]);

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
        availableCapabilities: capabilities,
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
        availableCapabilities: capabilities,
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
        availableCapabilities: capabilities,
      });

      const finalState = await runner.run({ type: "user_message", content: "Hello" });

      expect(finalState.tokensUsed).toBe(150);
    });
  });

  describe("tool use cycle", () => {
    it("should run full tool use loop: user → model(tool_use) → execute → model(text) → done", async () => {
      const mockModel = createMockModelPort([
        toolCallScript("call_1", "read_file", '{"path":"foo.ts"}'),
        textScript("The file contains: const x = 1;"),
      ]);

      const toolExecutor = createMockToolExecutor({
        read_file: { modelContent: "const x = 1;", isError: false },
      });

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
        toolExecutor,
        availableCapabilities: capabilities,
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
        availableCapabilities: capabilities,
      });

      const finalState = await runner.run({ type: "user_message", content: "Read both files" });

      expect(finalState.status).toBe("done");
      expect(finalState.messages).toHaveLength(5); // user, assistant(2 tool_use), tool(a), tool(b), assistant(text)
    });

    it("should not short-circuit the parallel batch when one tool execution rejects", async () => {
      const mockModel = createMockModelPort([
        [
          toolUseStart("call_1", "read_file"),
          toolUseDelta("call_1", '{"path":"a.ts"}'),
          toolUseStart("call_2", "read_file"),
          toolUseDelta("call_2", '{"path":"b.ts"}'),
          toolUseStart("call_3", "read_file"),
          toolUseDelta("call_3", '{"path":"bad.ts"}'),
          modelDone("tool_use"),
        ],
        textScript("Two read, one failed."),
      ]);

      const toolExecutor = createMockToolExecutor({
        read_file: { modelContent: "file content" },
      });

      // preToolUse hooks run OUTSIDE executeTool's try/catch — a throwing
      // hook rejects executeTool itself, exercising the allSettled fallback
      // that must normalize it into an error tool_result instead of losing
      // the whole parallel batch.
      const hooks: Hook[] = [
        {
          name: "flaky-hook",
          lifecycle: "preToolUse",
          handler: (ctx) => {
            if (ctx.toolCall?.input["path"] === "bad.ts") throw new Error("Hook crash");
            return { action: "continue" };
          },
        },
      ];

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
        toolExecutor,
        availableCapabilities: capabilities,
        hooks,
      });

      const finalState = await runner.run({ type: "user_message", content: "Read all three files" });

      expect(finalState.status).toBe("done");
      // user, assistant(3 tool_use), tool(a), tool(b), tool(error), assistant(text)
      expect(finalState.messages).toHaveLength(6);

      const toolMessages = finalState.messages.filter((m) => m.role === "tool");
      expect(toolMessages).toHaveLength(3);
      // Both healthy results were fed back normally…
      expect(toolMessages.filter((m) => !m.content[0]?.isError)).toHaveLength(2);
      // …and the rejected one was normalized to an error result, not dropped.
      const rejected = toolMessages.find((m) => m.content[0]?.isError);
      expect(rejected).toBeDefined();
      expect(rejected!.content[0]).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("Hook crash") }],
        isError: true,
      });
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
        availableCapabilities: capabilities,
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
        availableCapabilities: capabilities,
      });

      const finalState = await runner.run({ type: "user_message", content: "Read bad.ts" });

      expect(finalState.status).toBe("done");
      const toolMsg = finalState.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content[0]).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("Disk failure") }],
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
        availableCapabilities: capabilities,
      });

      const finalState = await runner.run({ type: "user_message", content: "Read test.ts" });

      const toolMsg = finalState.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content[0]).toMatchObject({ isError: true });
    });
  });

  describe("capability gating", () => {
    it("should return capability error when required capability is missing", async () => {
      const mockModel = createMockModelPort([
        toolCallScript("call_1", "read_file", '{"path":"a.ts"}'),
        textScript("cannot read"),
      ]);

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
        availableCapabilities: new Set(),
      });

      const finalState = await runner.run({ type: "user_message", content: "Read file" });

      expect(finalState.status).toBe("done");
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
        availableCapabilities: capabilities,
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
        availableCapabilities: capabilities,
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
        availableCapabilities: capabilities,
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
        availableCapabilities: capabilities,
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
        availableCapabilities: capabilities,
      });

      const finalState = await runner.run({ type: "user_message", content: "Hi" });

      expect(finalState.status).toBe("done");
    });
  });

  describe("event sink integration", () => {
    it("should forward transcript events and deltas to EventSink", async () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const eventSink: EventSink = {
        emit(event) { events.push(event); },
      };

      const mockModel = createMockModelPort([
        [reasoningDelta("let me think"), textDelta("Hello"), usage(10, 5), modelDone("end_turn")],
      ]);

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
        eventSink,
        availableCapabilities: capabilities,
      });

      await runner.run({ type: "user_message", content: "Hi" });

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("user_message");
      expect(eventTypes).toContain("reasoning_delta");
      expect(eventTypes).toContain("text_delta");
      expect(eventTypes).toContain("assistant_message");
      // The reducer's raw event vocabulary is gone from the wire (task-r6):
      // model_done is replaced by the recorded assistant_message, which
      // carries the aggregated reasoning (as a leading content block) and
      // the provider usage verbatim.
      expect(eventTypes).not.toContain("model_done");
      const assistant = events.find((e) => e.type === "assistant_message")!;
      expect(assistant.data).toMatchObject({
        content: [
          { type: "reasoning", text: "let me think" },
          { type: "text", text: "Hello" },
        ],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
        durationMs: expect.any(Number),
      });
    });

    it("streams the same stamped events it records, and never streams model_done/tool_use_complete", async () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const eventSink: EventSink = {
        emit(event) { events.push(event); },
      };
      const persisted: Array<{ type: string; data: Record<string, unknown> }> = [];
      const chatStore = {
        async appendEvents(_sessionId: string, batch: TranscriptEventInput[]) {
          persisted.push(...(batch as unknown as Array<{ type: string; data: Record<string, unknown> }>));
        },
      };

      const mockModel = createMockModelPort([
        [
          reasoningDelta("think about it"),
          toolUseStart("c1", "read_file"),
          toolUseDelta("c1", '{"path":"foo.ts"}'),
          modelDone("tool_use"),
        ],
        [textDelta("done"), modelDone("end_turn")],
      ]);

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
        eventSink,
        chatStore,
        chatSessionId: "chat-1",
        toolExecutor: async () => ({ modelContent: "const x = 1;", isError: false }),
        availableCapabilities: capabilities,
      });

      await runner.run({ type: "user_message", content: "Hi" });

      const streamTypes = events.map((e) => e.type);
      // Transcript vocabulary + deltas on the stream, no raw reducer twins.
      expect(streamTypes).not.toContain("model_done");
      expect(streamTypes).not.toContain("tool_use_complete");
      expect(streamTypes).toContain("assistant_message");
      expect(streamTypes).toContain("tool_call");
      expect(streamTypes).toContain("turn_end");

      // Every persisted event has a same-shaped twin on the stream (same
      // data + same time/turn/step — the recorder emits exactly what it
      // buffers, task-r6 double write). Deltas (text/reasoning/tool_use) are
      // the only stream events without a persisted twin.
      expect(persisted.length).toBeGreaterThan(0);
      const transcriptStreamed = events.filter(
        (e) => e.type !== "text_delta" && e.type !== "reasoning_delta" && e.type !== "tool_use_delta",
      );
      const sortKey = (e: { type: string; data: unknown }): string => JSON.stringify({ type: e.type, data: e.data });
      const streamedSorted = [...transcriptStreamed].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
      const persistedSorted = [...persisted].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
      expect(streamedSorted.length).toBe(persistedSorted.length);
      for (let i = 0; i < persistedSorted.length; i++) {
        expect(sortKey(streamedSorted[i]!)).toBe(sortKey(persistedSorted[i]!));
        expect((streamedSorted[i] as { time?: unknown }).time).toBe((persistedSorted[i] as { time?: unknown }).time);
        expect((streamedSorted[i] as { turn?: unknown }).turn).toBe((persistedSorted[i] as { turn?: unknown }).turn);
        expect((streamedSorted[i] as { step?: unknown }).step).toBe((persistedSorted[i] as { step?: unknown }).step);
      }
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
        availableCapabilities: capabilities,
      });

      const initialState = runner.getState();
      expect(initialState.status).toBe("idle");

      await runner.run({ type: "user_message", content: "Hi" });

      const finalState = runner.getState();
      expect(finalState.status).toBe("done");
    });
  });
});
