import { describe, it, expect } from "vitest";
import {
  emptyContextUsageFold,
  foldContextUsageEvent,
  contextUsageView,
  computeContextUsage,
  emptyContextUsageSnapshot,
  snapshotFold,
  foldSnapshotEvent,
  snapshotView,
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
    fold = foldContextUsageEvent(fold, event("steering_queued", { id: "steer-1", content: "abcdefgh" }), tokenizer);
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
        content: [
          { type: "reasoning", text: "abcd" },
          { type: "text", text: "abcdefgh" },
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
        ],
        durationMs: 5,
      }),
      tokenizer,
    );
    const view = contextUsageView(fold, tokenizer)!;
    // text "abcdefgh" → ceil(8/4)=2 + BLOCK_OVERHEAD(4) = 6;
    // tool_use "read_file" → ceil(9/4)=3 name + ceil(12/4)=3 for
    // JSON.stringify({path:"a"}) (12 chars) + BLOCK_OVERHEAD(4) = 10;
    // + ROLE_OVERHEAD(4) for the message = 6+10+4 = 20;
    // + reasoning "abcd" → ceil(4/4)=1 + BLOCK_OVERHEAD(4) = 5;
    // total = 20 + 5 = 25, all landing in the independent messages estimate.
    expect(view.anchored).toBe(false);
    expect(view.breakdown.messages).toBe(25);
  });

  it("does not floor projectedTokens to the header estimate when the anchored total is smaller", () => {
    let fold = foldContextUsageEvent(emptyContextUsageFold(), event("request_header", HEADER), tokenizer);
    fold = foldContextUsageEvent(
      fold,
      event("assistant_message", {
        content: [],
        durationMs: 5,
        usage: { inputTokens: 2, outputTokens: 0 }, // far smaller than the header estimate
      }),
      tokenizer,
    );
    const view = contextUsageView(fold, tokenizer)!;
    // Anchored: projectedTokens = 2(input) + 0(output) + 0(pending, cleared by
    // the re-anchor) = 2, no longer floored up by the header estimate
    // (system 7 + tools 22).
    expect(view.projectedTokens).toBe(2);
    expect(view.breakdown.system).toBe(7);
    // tools JSON string is 70 chars → ceil(70/4)=18 + BLOCK_OVERHEAD 4 = 22
    expect(view.breakdown.tools).toBe(22);
    // The messages bucket is an independent running total, from this
    // assistant_message's empty content:
    // countMessage([]) = countBlocks([])(0) + ROLE_OVERHEAD(4) = 4
    expect(view.breakdown.messages).toBe(4);
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

describe("independent message counting", () => {
  const heuristicTokenizer = createHeuristicTokenizer();
  const header = (text: string) => ({
    time: 0,
    type: "request_header" as const,
    data: { hash: "h", systemLayers: [{ id: "sys", text }], tools: [], params: {} },
  });
  const withUsage = (promptTokens: number) => ({
    time: 0,
    type: "assistant_message" as const,
    data: {
      content: [{ type: "text" as const, text: "ok" }],
      usage: { inputTokens: promptTokens, outputTokens: 5 },
      durationMs: 1,
    },
  });

  it("keeps messageTokens accumulating across an anchor reset", () => {
    let fold = emptyContextUsageFold();
    fold = foldContextUsageEvent(fold, header("x".repeat(40)), heuristicTokenizer);
    fold = foldContextUsageEvent(
      fold,
      { time: 0, type: "user_message", data: { content: "abcd" } },
      heuristicTokenizer,
    );
    const beforeAnchor = fold.messageTokens;
    expect(beforeAnchor).toBeGreaterThan(0);

    fold = foldContextUsageEvent(fold, withUsage(100), heuristicTokenizer);
    expect(fold.pendingTokens).toBe(0);
    expect(fold.messageTokens).toBeGreaterThan(beforeAnchor);
  });

  it("does not raise projectedTokens above the anchor when the header estimate is larger", () => {
    let fold = emptyContextUsageFold();
    // A 4000-char system layer estimates to ~1000 tokens, far above the anchor.
    fold = foldContextUsageEvent(fold, header("x".repeat(4000)), heuristicTokenizer);
    fold = foldContextUsageEvent(fold, withUsage(100), heuristicTokenizer);

    const view = contextUsageView(fold, heuristicTokenizer)!;
    expect(view.projectedTokens).toBe(105); // 100 prompt + 5 output, no floor
    expect(view.breakdown.system).toBeGreaterThan(view.projectedTokens);
  });

  it("resets both counters on a compaction, seeding messages from the summary", () => {
    let fold = emptyContextUsageFold();
    fold = foldContextUsageEvent(fold, header("x".repeat(40)), heuristicTokenizer);
    fold = foldContextUsageEvent(
      fold,
      {
        time: 0,
        type: "tool_result",
        data: { callId: "c", content: "y".repeat(4000), isError: false, orderInBatch: 0 },
      },
      heuristicTokenizer,
    );
    expect(fold.messageTokens).toBeGreaterThan(500);

    fold = foldContextUsageEvent(
      fold,
      { time: 0, type: "compaction", data: { replacedCount: 3, summaryText: "abcd" } },
      heuristicTokenizer,
    );
    expect(fold.pendingTokens).toBe(0);
    expect(fold.messageTokens).toBe(1 + 4); // summary tokens + BLOCK_OVERHEAD
  });

  it("uses the pure-estimate path before any anchor", () => {
    let fold = emptyContextUsageFold();
    fold = foldContextUsageEvent(fold, header("abcd"), heuristicTokenizer);
    fold = foldContextUsageEvent(
      fold,
      { time: 0, type: "user_message", data: { content: "abcd" } },
      heuristicTokenizer,
    );
    const view = contextUsageView(fold, heuristicTokenizer)!;
    expect(view.anchored).toBe(false);
    expect(view.projectedTokens).toBe(
      view.breakdown.system + view.breakdown.tools + view.breakdown.messages,
    );
  });
});

describe("snapshot equivalence", () => {
  const heuristicTokenizer = createHeuristicTokenizer();
  const snapEvents: TranscriptEventInput[] = [
    {
      time: 0,
      type: "request_header",
      data: {
        hash: "h1",
        systemLayers: [{ id: "sys", text: "x".repeat(40) }],
        tools: [{ name: "read_file", description: "d", schema: { type: "object" } }],
        params: {},
      },
    },
    { time: 1, type: "user_message", data: { content: "hello there" } },
    {
      time: 2,
      type: "assistant_message",
      data: {
        content: [{ type: "text", text: "hi" }],
        usage: { inputTokens: 200, outputTokens: 20 },
        durationMs: 1,
      },
    },
    { time: 3, type: "tool_result", data: { callId: "c", content: "result", isError: false, orderInBatch: 0 } },
  ];

  it("matches the full fold at every prefix", () => {
    for (let cut = 1; cut <= snapEvents.length; cut++) {
      const prefix = snapEvents.slice(0, cut);
      const fold = computeContextUsage(prefix, heuristicTokenizer);
      let snap = emptyContextUsageSnapshot();
      for (const event of prefix) snap = foldSnapshotEvent(snap, event, heuristicTokenizer);
      expect(snapshotView(snap)).toEqual(contextUsageView(fold, heuristicTokenizer));
    }
  });

  it("continues a server-made snapshot with client-side events", () => {
    const serverFold = computeContextUsage(snapEvents.slice(0, 2), heuristicTokenizer);
    let snap = snapshotFold(serverFold, heuristicTokenizer);
    for (const event of snapEvents.slice(2)) snap = foldSnapshotEvent(snap, event, heuristicTokenizer);

    const full = computeContextUsage(snapEvents, heuristicTokenizer);
    expect(snapshotView(snap)).toEqual(contextUsageView(full, heuristicTokenizer));
  });

  it("carries no full text", () => {
    const snap = snapshotFold(computeContextUsage(snapEvents, heuristicTokenizer), heuristicTokenizer);
    expect(JSON.stringify(snap)).not.toContain("xxxx");
    expect(JSON.stringify(snap)).not.toContain("read_file");
  });

  it("views an empty snapshot as null", () => {
    expect(snapshotView(emptyContextUsageSnapshot())).toBeNull();
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

describe("steering queue mutations", () => {
  it("context-usage treats steering_edited/removed as no-op and never double-counts", () => {
    let fold = foldContextUsageEvent(
      emptyContextUsageFold(),
      event("steering_queued", { id: "steer-1", content: "abcdefgh" }),
      tokenizer,
    );
    const counted = fold;

    // Realization must not re-count the message the queue already priced.
    fold = foldContextUsageEvent(fold, event("steering_delivered", { ids: ["steer-1"] }), tokenizer);
    expect(fold).toEqual(counted);

    // An edit replaces the queued content in the projections; the fold
    // ignores the delta (bounded error) and stays byte-identical.
    fold = foldContextUsageEvent(
      fold,
      event("steering_edited", { id: "steer-1", content: "brand new wording here" }),
      tokenizer,
    );
    expect(fold).toEqual(counted);

    // A withdrawal leaves no residue either — nothing is ever un-counted,
    // and nothing is counted twice.
    fold = foldContextUsageEvent(fold, event("steering_removed", { id: "steer-1" }), tokenizer);
    expect(fold).toEqual(counted);
  });

  it("the snapshot fold mirrors the same no-op rules", () => {
    let snap = emptyContextUsageSnapshot();
    snap = foldSnapshotEvent(snap, event("steering_queued", { id: "steer-1", content: "abcdefgh" }), tokenizer);
    const counted = snap;

    snap = foldSnapshotEvent(snap, event("steering_edited", { id: "steer-1", content: "brand new wording here" }), tokenizer);
    expect(snap).toEqual(counted);
    snap = foldSnapshotEvent(snap, event("steering_removed", { id: "steer-1" }), tokenizer);
    expect(snap).toEqual(counted);
  });
});
