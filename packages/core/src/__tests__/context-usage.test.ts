import { describe, it, expect } from "vitest";
import {
  emptyContextUsageFold,
  foldContextUsageEvent,
  contextUsageView,
  computeContextUsage,
} from "../context-usage.js";
import { createCharTokenizer } from "../testing/char-tokenizer.js";
import { createHeuristicTokenizer } from "../heuristic-tokenizer.js";
import type { TranscriptEventInput, TranscriptEventMap } from "../ports.js";

const tokenizer = createCharTokenizer();

/** 构造一个 TranscriptEventInput；text 长度 n 的估算 token 数 = max(1, ceil(n/4))。 */
function event<T extends TranscriptEventInput["type"]>(
  type: T,
  data: TranscriptEventMap[T],
): TranscriptEventInput {
  return { time: 0, type, data } as TranscriptEventInput;
}

const HEADER = {
  hash: "h1",
  systemLayers: [
    { id: "system-prompt", text: "abcdefgh" }, // 8 chars → 2 tokens
    { id: "project-memory:AGENTS.md", text: "abcd" }, // 4 chars → 1 token
  ],
  tools: [{ name: "read_file", description: "read", schema: { type: "object" } }],
  params: {},
};

describe("contextUsageView", () => {
  it("returns null when no request_header has been folded", () => {
    expect(contextUsageView(emptyContextUsageFold(), tokenizer)).toBeNull();
  });

  it("projects a pure estimate from the header before any anchor", () => {
    // system 2+1=3 + ROLE_OVERHEAD 4 = 7；tools = JSON.stringify 的启发式计数（具体值不假设，用 gt 断言）
    const fold = foldContextUsageEvent(emptyContextUsageFold(), event("request_header", HEADER), tokenizer);
    const view = contextUsageView(fold, tokenizer)!;
    expect(view.anchored).toBe(false);
    expect(view.breakdown.system).toBe(7);
    expect(view.breakdown.tools).toBeGreaterThan(0);
    expect(view.breakdown.messages).toBe(0);
    expect(view.projectedTokens).toBe(view.breakdown.system + view.breakdown.tools + view.breakdown.messages);
    expect(view.layers).toEqual([
      { id: "system-prompt", tokens: 2 },
      { id: "project-memory:AGENTS.md", tokens: 1 },
    ]);
  });

  it("counts user messages into the estimate before the first anchor", () => {
    let fold = foldContextUsageEvent(emptyContextUsageFold(), event("user_message", { content: "abcdefgh" }), tokenizer);
    fold = foldContextUsageEvent(fold, event("request_header", HEADER), tokenizer);
    const view = contextUsageView(fold, tokenizer)!;
    // 8 chars 的 user 消息 → 2 tokens + BLOCK_OVERHEAD 4 + ROLE_OVERHEAD 4 = 10；system 7
    expect(view.projectedTokens).toBe(7 + view.breakdown.tools + 10);
  });

  it("anchors on assistant usage: prompt = input + cacheRead + cacheWrite", () => {
    let fold = foldContextUsageEvent(emptyContextUsageFold(), event("request_header", HEADER), tokenizer);
    fold = foldContextUsageEvent(fold, event("user_message", { content: "hi" }), tokenizer);
    fold = foldContextUsageEvent(
      fold,
      event("assistant_message", {
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        durationMs: 5,
        usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 5 },
      }),
      tokenizer,
    );
    const view = contextUsageView(fold, tokenizer)!;
    expect(view.anchored).toBe(true);
    // 100 + 20 + 5 = 125 prompt；+30 输出；pendingTokens 已被重锚清零
    expect(view.projectedTokens).toBe(155);
  });

  it("accumulates tool_result and steering tokens after the anchor and re-anchors to zero", () => {
    let fold = foldContextUsageEvent(emptyContextUsageFold(), event("request_header", HEADER), tokenizer);
    fold = foldContextUsageEvent(
      fold,
      event("assistant_message", {
        content: [],
        durationMs: 5,
        usage: { inputTokens: 100, outputTokens: 10 },
      }),
      tokenizer,
    );
    fold = foldContextUsageEvent(fold, event("tool_result", { callId: "c1", content: "abcdefgh", isError: false, orderInBatch: 0 }), tokenizer);
    fold = foldContextUsageEvent(fold, event("steering_queued", { content: "abcdefgh" }), tokenizer);
    // 锚 100+10=110；tool_result "abcdefgh"→2+BLOCK_OVERHEAD(4)=6，
    // steering "abcdefgh"→2+BLOCK_OVERHEAD(4)+ROLE_OVERHEAD(4)=10，合计 110+6+10=126
    expect(contextUsageView(fold, tokenizer)!.projectedTokens).toBe(126);

    fold = foldContextUsageEvent(
      fold,
      event("assistant_message", {
        content: [],
        durationMs: 5,
        usage: { inputTokens: 120, outputTokens: 3 },
      }),
      tokenizer,
    );
    // 重锚清零 pending：120+3
    expect(contextUsageView(fold, tokenizer)!.projectedTokens).toBe(123);
  });

  it("estimates assistant output into pending when usage is absent", () => {
    let fold = foldContextUsageEvent(emptyContextUsageFold(), event("request_header", HEADER), tokenizer);
    fold = foldContextUsageEvent(
      fold,
      event("assistant_message", {
        content: [{ type: "text", text: "abcdefgh" }, { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } }],
        reasoning: "abcd",
        durationMs: 5,
      }),
      tokenizer,
    );
    const view = contextUsageView(fold, tokenizer)!;
    // pending = 2(text) + tool_use input JSON 估算(≥1) + 1(reasoning)；
    // 全部落在 messages 残差桶里
    expect(view.anchored).toBe(false);
    expect(view.breakdown.messages).toBe(view.projectedTokens - view.breakdown.system - view.breakdown.tools);
    expect(view.breakdown.messages).toBeGreaterThanOrEqual(3);
  });

  it("clamps the messages residual at zero when header estimates exceed the anchored total", () => {
    let fold = foldContextUsageEvent(emptyContextUsageFold(), event("request_header", HEADER), tokenizer);
    fold = foldContextUsageEvent(
      fold,
      event("assistant_message", {
        content: [],
        durationMs: 5,
        usage: { inputTokens: 2, outputTokens: 0 }, // 远小于 header 估算
      }),
      tokenizer,
    );
    const view = contextUsageView(fold, tokenizer)!;
    expect(view.breakdown.messages).toBe(0);
    expect(view.projectedTokens).toBe(view.breakdown.system + view.breakdown.tools);
  });
});

describe("structural overhead", () => {
  const heuristicTokenizer = createHeuristicTokenizer();

  it("adds per-block overhead to a text block", () => {
    // "abcd" = 1 token + BLOCK_OVERHEAD 4 + ROLE_OVERHEAD 4
    const fold = foldContextUsageEvent(
      emptyContextUsageFold(),
      { time: 0, type: "user_message", data: { content: [{ type: "text", text: "abcd" }] } },
      heuristicTokenizer,
    );
    expect(fold.pendingTokens).toBe(9);
  });

  it("prices a string user message with role overhead", () => {
    const fold = foldContextUsageEvent(
      emptyContextUsageFold(),
      { time: 0, type: "user_message", data: { content: "abcd" } },
      heuristicTokenizer,
    );
    expect(fold.pendingTokens).toBe(9);
  });

  it("prices a tool_use block by name plus serialized input", () => {
    const input = { path: "a.ts" };
    const expected =
      Math.ceil("read_file".length / 4) +
      Math.ceil(JSON.stringify(input).length / 4) +
      4 + // BLOCK_OVERHEAD
      4; // ROLE_OVERHEAD
    const fold = foldContextUsageEvent(
      emptyContextUsageFold(),
      {
        time: 0,
        type: "assistant_message",
        data: {
          content: [{ type: "tool_use", id: "c1", name: "read_file", input }],
          durationMs: 1,
        },
      },
      heuristicTokenizer,
    );
    expect(fold.pendingTokens).toBe(expected);
  });

  it("adds block overhead to a tool result", () => {
    const fold = foldContextUsageEvent(
      emptyContextUsageFold(),
      {
        time: 0,
        type: "tool_result",
        data: { callId: "c1", content: "abcd", isError: false, orderInBatch: 0 },
      },
      heuristicTokenizer,
    );
    expect(fold.pendingTokens).toBe(5); // 1 + BLOCK_OVERHEAD
  });
});

describe("foldContextUsageEvent determinism", () => {
  it("folds the same event sequence to an identical state", () => {
    const events: TranscriptEventInput[] = [
      event("user_message", { content: "hi" }),
      event("request_header", HEADER),
      event("assistant_message", { content: [{ type: "text", text: "ok" }], durationMs: 5, usage: { inputTokens: 10, outputTokens: 2 } }),
      event("tool_result", { callId: "c1", content: "abcd", isError: false, orderInBatch: 0 }),
    ];
    const a = computeContextUsage(events, tokenizer);
    const b = events.reduce((f, e) => foldContextUsageEvent(f, e, tokenizer), emptyContextUsageFold());
    expect(a).toEqual(b);
  });
});
