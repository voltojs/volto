import { describe, it, expect } from "vitest";
import { normalizeStream } from "../stream-normalize.js";
import type { RawAnthropicEvent } from "../stream-normalize.js";
import type { ModelEvent } from "@volto/core";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

async function collect(events: RawAnthropicEvent[]): Promise<ModelEvent[]> {
  async function* generate() {
    for (const event of events) {
      yield event;
    }
  }
  const result: ModelEvent[] = [];
  for await (const event of normalizeStream(generate())) {
    result.push(event);
  }
  return result;
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("normalizeStream (Anthropic)", () => {
  describe("text response", () => {
    it("should normalize a basic text response", async () => {
      const events = await collect([
        { type: "message_start", message: { usage: { input_tokens: 25, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } },
        { type: "message_stop" },
      ]);

      const textEvents = events.filter((e) => e.type === "text_delta");
      expect(textEvents).toHaveLength(2);
      expect(textEvents[0]).toMatchObject({ type: "text_delta", text: "Hello" });
      expect(textEvents[1]).toMatchObject({ type: "text_delta", text: " world" });

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toMatchObject({ type: "done", stopReason: "end_turn" });
    });

    it("should skip ping events", async () => {
      const events = await collect([
        { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
        { type: "ping" },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "ping" },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ]);

      const textEvents = events.filter((e) => e.type === "text_delta");
      expect(textEvents).toHaveLength(1);
      expect(textEvents[0]).toMatchObject({ text: "Hi" });
    });
  });

  describe("thinking (reasoning) response", () => {
    it("should emit reasoning_delta for thinking blocks", async () => {
      const events = await collect([
        { type: "message_start", message: { usage: { input_tokens: 50, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think..." } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " step by step" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc123" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "The answer is 42." } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } },
        { type: "message_stop" },
      ]);

      const reasoningEvents = events.filter((e) => e.type === "reasoning_delta");
      expect(reasoningEvents).toHaveLength(2);
      expect(reasoningEvents[0]).toMatchObject({ type: "reasoning_delta", text: "Let me think..." });
      expect(reasoningEvents[1]).toMatchObject({ type: "reasoning_delta", text: " step by step" });

      const textEvents = events.filter((e) => e.type === "text_delta");
      expect(textEvents).toHaveLength(1);
      expect(textEvents[0]).toMatchObject({ text: "The answer is 42." });

      // signature_delta should be skipped (no event for it)
      expect(events.find((e) => (e as { type?: string }).type === "signature_delta")).toBeUndefined();
    });
  });

  describe("tool use", () => {
    it("should handle a single tool use: start → input_json_delta → stop", async () => {
      const events = await collect([
        { type: "message_start", message: { usage: { input_tokens: 472, output_tokens: 2 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check." } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01T1x", name: "get_weather", input: {} } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"location":' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' "SF"}' } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 89 } },
        { type: "message_stop" },
      ]);

      const toolStartEvents = events.filter((e) => e.type === "tool_use_start");
      expect(toolStartEvents).toHaveLength(1);
      expect(toolStartEvents[0]).toMatchObject({
        type: "tool_use_start",
        toolCallId: "toolu_01T1x",
        toolName: "get_weather",
      });

      const toolDeltaEvents = events.filter((e) => e.type === "tool_use_delta");
      expect(toolDeltaEvents).toHaveLength(3);
      expect(toolDeltaEvents[0]).toMatchObject({ argumentsDelta: "" });
      expect(toolDeltaEvents[1]).toMatchObject({ argumentsDelta: '{"location":' });
      expect(toolDeltaEvents[2]).toMatchObject({ argumentsDelta: ' "SF"}' });

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toMatchObject({ stopReason: "tool_use" });
    });

    it("should handle server_tool_use blocks", async () => {
      const events = await collect([
        { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 2 } } },
        { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtool_01", name: "web_search", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"weather"}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } },
        { type: "message_stop" },
      ]);

      const toolStartEvents = events.filter((e) => e.type === "tool_use_start");
      expect(toolStartEvents).toHaveLength(1);
      expect(toolStartEvents[0]).toMatchObject({
        type: "tool_use_start",
        toolCallId: "srvtool_01",
        toolName: "web_search",
      });
    });
  });

  describe("usage", () => {
    it("should emit usage with input tokens from message_start and output tokens from message_delta", async () => {
      const events = await collect([
        { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } },
        { type: "message_stop" },
      ]);

      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]).toMatchObject({
        type: "usage",
        inputTokens: 100,
        outputTokens: 50,
      });
    });

    it("should include cache tokens when present", async () => {
      const events = await collect([
        { type: "message_start", message: { usage: { input_tokens: 200, output_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 50 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } },
        { type: "message_stop" },
      ]);

      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]).toMatchObject({
        type: "usage",
        inputTokens: 200,
        outputTokens: 20,
        cacheReadTokens: 50,
        cacheWriteTokens: 100,
      });
    });

    it("should default to 0 for missing token counts", async () => {
      const events = await collect([
        { type: "message_start", message: { usage: {} } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "X" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
        { type: "message_stop" },
      ]);

      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    });
  });

  describe("stop reason mapping", () => {
    it("should map 'end_turn' to 'end_turn'", async () => {
      const events = await collect([
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      ]);
      expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "end_turn" });
    });

    it("should map 'tool_use' to 'tool_use'", async () => {
      const events = await collect([
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
      ]);
      expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "tool_use" });
    });

    it("should map 'max_tokens' to 'max_tokens'", async () => {
      const events = await collect([
        { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 5 } },
      ]);
      expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "max_tokens" });
    });

    it("should map unknown stop reasons to 'end_turn'", async () => {
      const events = await collect([
        { type: "message_delta", delta: { stop_reason: "unknown_reason" }, usage: { output_tokens: 5 } },
      ]);
      expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "end_turn" });
    });
  });

  describe("error events", () => {
    it("should emit error for API errors", async () => {
      const events = await collect([
        { type: "error", error: { type: "invalid_request_error", message: "Bad request" } },
      ]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "error",
        error: "Anthropic API error: Bad request",
        retriable: false,
      });
    });

    it("should mark overloaded errors as retriable", async () => {
      const events = await collect([
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      ]);
      expect(events[0]).toMatchObject({
        type: "error",
        error: "Anthropic API error: Overloaded",
        retriable: true,
      });
    });
  });

  describe("empty stream", () => {
    it("should produce no events for empty stream", async () => {
      const events = await collect([]);
      expect(events).toHaveLength(0);
    });
  });
});
