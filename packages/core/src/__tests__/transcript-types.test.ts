import { describe, it, expect } from "vitest";
import type {
  TokenUsage,
  TranscriptEvent,
  TranscriptEventInput,
  TranscriptEventMap,
  TranscriptStore,
} from "../index.js";

describe("transcript event types", () => {
  it("TokenUsage carries cache and reasoning counters", () => {
    const usage: TokenUsage = {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      reasoningTokens: 7,
    };
    expect(usage.cacheReadTokens).toBe(5);
    expect(usage.reasoningTokens).toBe(7);
  });

  it("an input has no seq; a stored event does", () => {
    const input: TranscriptEventInput<"turn_start"> = {
      time: 1000,
      type: "turn_start",
      data: { turn: 1 },
      turn: 1,
    };
    const stored: TranscriptEvent<"turn_start"> = { ...input, seq: 0 };
    expect(stored.seq).toBe(0);
    // @ts-expect-error — seq is not part of the input shape
    expect(input.seq).toBeUndefined();
  });

  it("assistant_message carries reasoning, usage and timing", () => {
    const data: TranscriptEventMap["assistant_message"] = {
      content: [{ type: "text", text: "hi" }],
      reasoning: "let me think",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 2 },
      ttftMs: 120,
      durationMs: 800,
    };
    expect(data.reasoning).toBe("let me think");
    expect(data.ttftMs).toBe(120);
  });

  it("tool_result carries the real content and its batch order", () => {
    const data: TranscriptEventMap["tool_result"] = {
      callId: "c1",
      name: "read_file",
      content: "file contents",
      isError: false,
      durationMs: 12,
      orderInBatch: 0,
    };
    expect(data.content).toBe("file contents");
    expect(data.orderInBatch).toBe(0);
  });

  it("TranscriptStore exposes appendEvents only", () => {
    const store: TranscriptStore = {
      async appendEvents() {},
    };
    expect(Object.keys(store)).toEqual(["appendEvents"]);
  });
});
