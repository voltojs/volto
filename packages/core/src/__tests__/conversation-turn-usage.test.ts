/**
 * 整轮用量汇总（spec 2026-09-26 §3.2）：一轮 = 一次用户输入触发的全部模型
 * 调用，汇总只挂在该轮最后一条 assistant 消息上；缺测显式计数而不是当 0。
 */
import { describe, it, expect } from "vitest";
import { buildTurnRecords, toConversationView } from "../view-projection.js";
import type { ContentBlock, TokenUsage, TranscriptEvent } from "../index.js";

function log(entries: Array<Omit<TranscriptEvent, "seq">>): TranscriptEvent[] {
  return entries.map((e, i) => ({ ...e, seq: i }) as TranscriptEvent);
}

interface CallFixture {
  step: number;
  usage?: TokenUsage;
  source?: { providerId?: string; modelId: string };
  content?: ContentBlock[];
}

/** 一轮：turn_start → user_message → 每次模型调用（call_start + assistant_message）→ turn_end。 */
function turnLog(turn: number, calls: CallFixture[]): Array<Omit<TranscriptEvent, "seq">> {
  const out: Array<Omit<TranscriptEvent, "seq">> = [
    { time: turn * 1000, type: "turn_start", data: { turn }, turn },
    { time: turn * 1000 + 1, type: "user_message", data: { content: "go" }, turn },
  ];
  for (const call of calls) {
    out.push({
      time: turn * 1000 + call.step * 10,
      type: "model_call_start",
      data: { headerHash: "h1" },
      turn,
      step: call.step,
    });
    out.push({
      time: turn * 1000 + call.step * 10 + 1,
      type: "assistant_message",
      data: {
        content: call.content ?? [{ type: "text", text: `step ${call.step}` }],
        stopReason: "end_turn",
        ...(call.usage !== undefined ? { usage: call.usage } : {}),
        ...(call.source !== undefined ? { source: call.source } : {}),
        durationMs: 5,
      },
      turn,
      step: call.step,
    });
  }
  out.push({ time: turn * 1000 + 999, type: "turn_end", data: { turn, reason: "done" }, turn });
  return out;
}

/** 截图金样本：两次调用相加正好是 dsh 卡片上的那组数字。 */
const GOLD_CALLS: CallFixture[] = [
  {
    step: 1,
    usage: { inputTokens: 19_352, outputTokens: 1_000, cacheReadTokens: 23_832_832, cacheWriteTokens: 0 },
    source: { providerId: "deepseek-official", modelId: "deepseek-flash" },
  },
  {
    step: 2,
    usage: { inputTokens: 0, outputTokens: 45_832, cacheReadTokens: 0, cacheWriteTokens: 0 },
    source: { providerId: "deepseek-official", modelId: "deepseek-flash" },
  },
];

describe("toConversationView turn usage", () => {
  it("sums a multi-call round and attaches it to the LAST assistant message only", () => {
    const view = toConversationView(buildTurnRecords(log(turnLog(1, GOLD_CALLS))));
    const assistants = view.messages.filter((m) => m.role === "assistant");

    expect(assistants).toHaveLength(2);
    expect(assistants[0]!.turnUsage).toBeUndefined();
    expect(assistants[1]!.turnUsage).toEqual({
      inputTokens: 19_352,
      outputTokens: 46_832,
      cacheReadTokens: 23_832_832,
      cacheWriteTokens: 0,
      totalTokens: 23_899_016,
      source: { providerId: "deepseek-official", modelId: "deepseek-flash" },
      missingUsageCalls: 0,
    });
  });

  it("takes the route from the last call that carried one", () => {
    const view = toConversationView(
      buildTurnRecords(
        log(
          turnLog(1, [
            { step: 1, usage: { inputTokens: 10, outputTokens: 1 }, source: { providerId: "provider-a", modelId: "cheap" } },
            { step: 2, usage: { inputTokens: 20, outputTokens: 2 }, source: { providerId: "provider-b", modelId: "strong" } },
          ]),
        ),
      ),
    );
    expect(view.messages.at(-1)!.turnUsage!.source).toEqual({
      providerId: "provider-b",
      modelId: "strong",
    });
  });

  it("keeps a trailing source-bearing call even when it reported no usage", () => {
    const view = toConversationView(
      buildTurnRecords(
        log(
          turnLog(1, [
            { step: 1, usage: { inputTokens: 10, outputTokens: 1 }, source: { providerId: "provider-a", modelId: "a" } },
            // 最后一次调用只留下路由、没有用量——model_error / 流式收尾的常见形态。
            // 取「最后一个 source 非 undefined 的调用」与「该 step 有没有 usage」无关
            // （spec §3.2 全局约束）：source 仍取它，而不是退回上一次有 usage 的调用。
            { step: 2, source: { providerId: "provider-b", modelId: "b" } },
          ]),
        ),
      ),
    );
    const usage = view.messages.at(-1)!.turnUsage!;
    expect(usage.source).toEqual({ providerId: "provider-b", modelId: "b" });
    // 该调用没上报用量 → 计入缺失，而不是因此拿不到它的 source。
    expect(usage.missingUsageCalls).toBe(1);
  });

  it("counts calls that reported no usage instead of summing them as zero", () => {
    const view = toConversationView(
      buildTurnRecords(
        log(
          turnLog(1, [
            { step: 1, usage: { inputTokens: 10, outputTokens: 2 } },
            // 第二次调用没上报用量（例如 model_error 之后的空 step）。
            { step: 2 },
          ]),
        ),
      ),
    );
    const usage = view.messages.at(-1)!.turnUsage!;
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 12,
      missingUsageCalls: 1,
    });
    // 整轮没有 source → 该键不存在，而不是 undefined 值。
    expect(Object.keys(usage)).not.toContain("source");
  });

  it("attaches nothing when no call in the round reported usage", () => {
    const view = toConversationView(buildTurnRecords(log(turnLog(1, [{ step: 1 }, { step: 2 }]))));
    expect(view.messages.every((m) => m.turnUsage === undefined)).toBe(true);
  });

  it("attaches nothing when the round's only call died before producing a message", () => {
    const noAssistant = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "user_message", data: { content: "go" }, turn: 1 },
      { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      { time: 130, type: "turn_end", data: { turn: 1, reason: "error" }, turn: 1 },
    ]);
    const view = toConversationView(buildTurnRecords(noAssistant));
    // 投影对每个 step 都出一条 assistant 消息（内容为空），但没有任何用量可挂。
    expect(view.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(view.messages.every((m) => m.turnUsage === undefined)).toBe(true);
  });

  it("sums a cancelled round the same way: turn_end's reason never gates the totals", () => {
    const cancelled = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "user_message", data: { content: "go" }, turn: 1 },
      { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      {
        time: 130,
        type: "assistant_message",
        data: {
          content: [{ type: "text", text: "partial answer" }],
          stopReason: "end_turn",
          usage: { inputTokens: 7, outputTokens: 3 },
          source: { providerId: "deepseek-official", modelId: "deepseek-flash" },
          durationMs: 5,
          interrupted: true,
        },
        turn: 1,
        step: 1,
      },
      { time: 140, type: "turn_end", data: { turn: 1, reason: "cancelled" }, turn: 1 },
    ]);
    const view = toConversationView(buildTurnRecords(cancelled));
    expect(view.messages.at(-1)!.turnUsage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 10,
      source: { providerId: "deepseek-official", modelId: "deepseek-flash" },
      missingUsageCalls: 0,
    });
  });
});
