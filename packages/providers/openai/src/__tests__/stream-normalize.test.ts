import { describe, it, expect } from "vitest";
import { normalizeStream } from "../stream-normalize.js";
import type { RawStreamChunk } from "../stream-normalize.js";
import type { ModelEvent } from "@voltojs/core";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

async function collect(
  chunks: RawStreamChunk[],
  options?: { includeUsageRequested?: boolean },
): Promise<ModelEvent[]> {
  async function* generate() {
    for (const chunk of chunks) {
      yield chunk;
    }
  }
  const events: ModelEvent[] = [];
  for await (const event of normalizeStream(generate(), options)) {
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

    it("should map total_tokens and completion_tokens_details.reasoning_tokens onto the usage event", async () => {
      const events = await collect([
        chunk({ content: "Hi" }),
        chunk({}, "stop", {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          completion_tokens_details: { reasoning_tokens: 20 },
        }),
      ]);

      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]).toMatchObject({
        type: "usage",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        reasoningTokens: 20,
      });
    });

    it("should leave totalTokens and reasoningTokens undefined when the provider omits them", async () => {
      const events = await collect([
        chunk({}, "stop", { prompt_tokens: 10, completion_tokens: 5 }),
      ]);

      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]).toMatchObject({ totalTokens: undefined, reasoningTokens: undefined });
    });

    it("splits cached tokens out of prompt_tokens (uncached inputTokens semantics)", async () => {
      const events = await collect([
        chunk({}, "stop", {
          prompt_tokens: 100,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 30 },
        }),
      ]);
      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]).toMatchObject({
        type: "usage",
        inputTokens: 70, // uncached only — matches Anthropic's input_tokens semantics
        outputTokens: 50,
        cacheReadTokens: 30,
      });
      // 恒等式：未命中 + 命中 = 完整 prompt
      const usage = usageEvents[0] as Extract<ModelEvent, { type: "usage" }>;
      expect(usage.inputTokens + (usage.cacheReadTokens ?? 0)).toBe(100);
    });

    it("keeps inputTokens equal to prompt_tokens when nothing was cached", async () => {
      const events = await collect([
        chunk({}, "stop", { prompt_tokens: 100, completion_tokens: 50 }),
      ]);
      const usage = events.find((e) => e.type === "usage") as Extract<ModelEvent, { type: "usage" }>;
      expect(usage.inputTokens).toBe(100);
      expect(usage.cacheReadTokens).toBeUndefined();
    });

    it("reads DeepSeek's hit/miss split", async () => {
      const events = await collect([
        chunk({}, "stop", {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_cache_hit_tokens: 60,
          prompt_cache_miss_tokens: 40,
        }),
      ]);
      const usage = events.find((e) => e.type === "usage") as Extract<ModelEvent, { type: "usage" }>;
      expect(usage.inputTokens).toBe(40);
      expect(usage.cacheReadTokens).toBe(60);
      expect(usage.inputTokens + (usage.cacheReadTokens ?? 0)).toBe(100);
    });

    it("reads OpenAI's cached_tokens detail while prompt_tokens stays the full prompt", async () => {
      const events = await collect([
        chunk({}, "stop", {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 60 },
        }),
      ]);
      const usage = events.find((e) => e.type === "usage") as Extract<ModelEvent, { type: "usage" }>;
      expect(usage.inputTokens).toBe(40);
      expect(usage.cacheReadTokens).toBe(60);
    });

    it("falls back to prompt_cache_hit_tokens's miss value even when zero", async () => {
      // Hostile/inconsistent payload: hit is present but miss is absent.
      // The expression `miss ?? (promptTokens - cachedTokens)` should still
      // recompute a sane uncached value from prompt_tokens instead of NaN/undefined.
      const events = await collect([
        chunk({}, "stop", {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_cache_hit_tokens: 60,
        }),
      ]);
      const usage = events.find((e) => e.type === "usage") as Extract<ModelEvent, { type: "usage" }>;
      expect(usage.inputTokens).toBe(40);
      expect(usage.cacheReadTokens).toBe(60);
    });

    it("derives cachedTokens from prompt_tokens when miss is present without hit", async () => {
      // Hostile/inconsistent payload: miss is present but hit is absent.
      // cachedTokens must still be recovered from prompt_tokens - miss so the
      // input + cacheRead + cacheWrite === prompt_tokens identity holds.
      const events = await collect([
        chunk({}, "stop", {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_cache_miss_tokens: 40,
        }),
      ]);
      const usage = events.find((e) => e.type === "usage") as Extract<ModelEvent, { type: "usage" }>;
      expect(usage.inputTokens).toBe(40);
      expect(usage.cacheReadTokens).toBe(60);
      expect(usage.inputTokens + (usage.cacheReadTokens ?? 0)).toBe(100);
    });

    it("never reports a negative uncached input", async () => {
      const events = await collect([
        chunk({}, "stop", {
          prompt_tokens: 10,
          completion_tokens: 0,
          prompt_tokens_details: { cached_tokens: 30 }, // 异常 provider：cached > prompt
        }),
      ]);
      const usage = events.find((e) => e.type === "usage") as Extract<ModelEvent, { type: "usage" }>;
      expect(usage.inputTokens).toBe(0);
      expect(usage.cacheReadTokens).toBe(30);
    });
  });

  describe("usage_unavailable", () => {
    it("emits usage_unavailable when include_usage was requested and no usage chunk ever arrives", async () => {
      const events = await collect(
        [chunk({ content: "Hi" }), chunk({}, "stop")],
        { includeUsageRequested: true },
      );
      const unavailable = events.filter((e) => e.type === "usage_unavailable");
      expect(unavailable).toHaveLength(1);
    });

    it("does not emit usage_unavailable when usage was reported", async () => {
      const events = await collect(
        [chunk({ content: "Hi" }), chunk({}, "stop", { prompt_tokens: 10, completion_tokens: 5 })],
        { includeUsageRequested: true },
      );
      const unavailable = events.filter((e) => e.type === "usage_unavailable");
      expect(unavailable).toHaveLength(0);
    });

    it("does not emit usage_unavailable when include_usage was not requested", async () => {
      const events = await collect([chunk({ content: "Hi" }), chunk({}, "stop")]);
      const unavailable = events.filter((e) => e.type === "usage_unavailable");
      expect(unavailable).toHaveLength(0);
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
