import { describe, it, expect } from "vitest";
import { normalizeStream } from "../stream-normalize.js";
import type { RawStreamChunk } from "../stream-normalize.js";
import type { ModelEvent } from "@agent-core/core";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

async function collect(chunks: RawStreamChunk[]): Promise<ModelEvent[]> {
  async function* generate() {
    for (const chunk of chunks) {
      yield chunk;
    }
  }
  const events: ModelEvent[] = [];
  for await (const event of normalizeStream(generate())) {
    events.push(event);
  }
  return events;
}

/** Helper to build a raw chunk with minimal boilerplate */
function chunk(
  delta: Record<string, unknown>,
  finishReason?: string | null,
  usage?: RawStreamChunk["usage"],
): RawStreamChunk {
  return {
    choices: [{ delta, finish_reason: finishReason ?? null }],
    usage: usage ?? null,
  };
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("normalizeStream", () => {
  describe("text delta", () => {
    it("should emit text_delta events", async () => {
      const events = await collect([
        chunk({ content: "Hello" }),
        chunk({ content: " world!" }),
        chunk({}, "stop"),
      ]);

      const textEvents = events.filter((e) => e.type === "text_delta");
      expect(textEvents).toHaveLength(2);
      expect(textEvents[0]).toMatchObject({ type: "text_delta", text: "Hello" });
      expect(textEvents[1]).toMatchObject({ type: "text_delta", text: " world!" });
    });

    it("should handle null content gracefully", async () => {
      const events = await collect([
        chunk({ content: null }),
        chunk({ content: "Hi" }),
        chunk({}, "stop"),
      ]);

      const textEvents = events.filter((e) => e.type === "text_delta");
      expect(textEvents).toHaveLength(1);
      expect(textEvents[0]).toMatchObject({ text: "Hi" });
    });
  });

  describe("reasoning delta", () => {
    it("should emit reasoning_delta for reasoning_content field", async () => {
      const events = await collect([
        chunk({ reasoning_content: "Let me think..." }),
        chunk({}, "stop"),
      ]);

      const reasoningEvents = events.filter((e) => e.type === "reasoning_delta");
      expect(reasoningEvents).toHaveLength(1);
      expect(reasoningEvents[0]).toMatchObject({ type: "reasoning_delta", text: "Let me think..." });
    });

    it("should emit reasoning_delta for reasoning field (alternative name)", async () => {
      const events = await collect([
        chunk({ reasoning: "Thinking..." }),
        chunk({}, "stop"),
      ]);

      const reasoningEvents = events.filter((e) => e.type === "reasoning_delta");
      expect(reasoningEvents).toHaveLength(1);
    });

    it("should emit reasoning_delta for thinking field", async () => {
      const events = await collect([
        chunk({ thinking: "Analyzing..." }),
        chunk({}, "stop"),
      ]);

      const reasoningEvents = events.filter((e) => e.type === "reasoning_delta");
      expect(reasoningEvents).toHaveLength(1);
    });
  });

  describe("tool call streaming", () => {
    it("should handle a single tool call: start → delta → done", async () => {
      const events = await collect([
        chunk({
          tool_calls: [{
            index: 0,
            id: "call_abc",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"' },
          }],
        }),
        chunk({
          tool_calls: [{
            index: 0,
            function: { arguments: 'foo.ts"}' },
          }],
        }),
        chunk({}, "tool_calls"),
      ]);

      const toolEvents = events.filter((e) =>
        e.type === "tool_use_start" || e.type === "tool_use_delta",
      );
      expect(toolEvents).toHaveLength(3);
      expect(toolEvents[0]).toMatchObject({
        type: "tool_use_start",
        toolCallId: "call_abc",
        toolName: "read_file",
      });
      expect(toolEvents[1]).toMatchObject({
        type: "tool_use_delta",
        toolCallId: "call_abc",
        argumentsDelta: '{"path":"',
      });
      expect(toolEvents[2]).toMatchObject({
        type: "tool_use_delta",
        toolCallId: "call_abc",
        argumentsDelta: 'foo.ts"}',
      });
    });

    it("should handle multiple parallel tool calls by index", async () => {
      const events = await collect([
        chunk({
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
            { index: 1, id: "call_2", type: "function", function: { name: "read_file", arguments: '{"path":"b"}' } },
          ],
        }),
        chunk({
          tool_calls: [
            { index: 0, function: { arguments: "" } },
            { index: 1, function: { arguments: "" } },
          ],
        }),
        chunk({}, "tool_calls"),
      ]);

      const startEvents = events.filter((e) => e.type === "tool_use_start");
      expect(startEvents).toHaveLength(2);
      expect(startEvents[0]).toMatchObject({ toolCallId: "call_1", toolName: "read_file" });
      expect(startEvents[1]).toMatchObject({ toolCallId: "call_2", toolName: "read_file" });
    });

    it("should handle tool call with all arguments in first chunk", async () => {
      const events = await collect([
        chunk({
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"complete.ts"}' },
          }],
        }),
        chunk({}, "tool_calls"),
      ]);

      const startEvents = events.filter((e) => e.type === "tool_use_start");
      const deltaEvents = events.filter((e) => e.type === "tool_use_delta");
      expect(startEvents).toHaveLength(1);
      // First chunk carries both start and delta
      expect(deltaEvents).toHaveLength(1);
      expect(deltaEvents[0]).toMatchObject({
        argumentsDelta: '{"path":"complete.ts"}',
      });
    });
  });

  describe("usage", () => {
    it("should emit usage event when present", async () => {
      const events = await collect([
        chunk({ content: "Hi" }),
        chunk({}, "stop", { prompt_tokens: 100, completion_tokens: 50 }),
      ]);

      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]).toMatchObject({
        type: "usage",
        inputTokens: 100,
        outputTokens: 50,
      });
    });

    it("should handle missing token counts gracefully", async () => {
      const events = await collect([
        chunk({}, "stop", { prompt_tokens: undefined, completion_tokens: undefined }),
      ]);

      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]).toMatchObject({
        type: "usage",
        inputTokens: 0,
        outputTokens: 0,
      });
    });
  });

  describe("finish reason mapping", () => {
    it("should map 'stop' to 'end_turn'", async () => {
      const events = await collect([chunk({}, "stop")]);
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toMatchObject({ type: "done", stopReason: "end_turn" });
    });

    it("should map 'tool_calls' to 'tool_use'", async () => {
      const events = await collect([chunk({}, "tool_calls")]);
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toMatchObject({ type: "done", stopReason: "tool_use" });
    });

    it("should map 'length' to 'max_tokens'", async () => {
      const events = await collect([chunk({}, "length")]);
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toMatchObject({ type: "done", stopReason: "max_tokens" });
    });

    it("should map unknown finish reasons to 'end_turn'", async () => {
      const events = await collect([chunk({}, "content_filter")]);
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toMatchObject({ type: "done", stopReason: "end_turn" });
    });
  });

  describe("empty stream", () => {
    it("should produce no events for empty stream", async () => {
      const events = await collect([]);
      expect(events).toHaveLength(0);
    });

    it("should handle chunks with no choices", async () => {
      const events = await collect([{ choices: undefined }]);
      expect(events).toHaveLength(0);
    });
  });
});
