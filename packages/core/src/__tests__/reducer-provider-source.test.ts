/**
 * providerId 溯源（spec 2026-09-26 §3.1）：宿主的 provider 配置 id 只在设置时
 * 落进 assistant_message.source，**绝不写 undefined 值**——后者会让既有
 * `toEqual({ modelId })` 断言与"没有该字段"的语义同时失真。
 */
import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../index.js";
import type { ReducerState, StepContext, Effect } from "../index.js";

function emitted(effects: Effect[], type: string): Record<string, unknown> | undefined {
  for (const e of effects) {
    if (e.type === "emit" && e.event.type === type) return e.event.data;
  }
  return undefined;
}

/** 跑 user → text → model_done，取回 model_done 事件里那条 assistant 消息。 */
function assistantMessage(ctx: StepContext): Record<string, unknown> {
  let state: ReducerState = createInitialState();
  state = step(state, { type: "user_message", content: "hi" }, ctx).state;
  state = step(
    state,
    { type: "model_chunk", chunk: { type: "text_delta", text: "hello" } },
    ctx,
  ).state;
  const result = step(state, { type: "model_done", stopReason: "end_turn" }, ctx);
  const data = emitted(result.effects, "model_done");
  expect(data).toBeDefined();
  return data!["message"] as Record<string, unknown>;
}

describe("assistant_message.source provenance", () => {
  it("stamps providerId next to modelId when the host supplies one", () => {
    const message = assistantMessage({
      tools: [],
      model: "deepseek-flash",
      providerId: "deepseek-official",
    });
    expect(message["source"]).toEqual({
      providerId: "deepseek-official",
      modelId: "deepseek-flash",
    });
  });

  it("omits the key entirely when the host supplies none", () => {
    const message = assistantMessage({ tools: [], model: "deepseek-flash" });
    expect(message["source"]).toEqual({ modelId: "deepseek-flash" });
    // 不是一个值为 undefined 的键：序列化后必须只有 modelId。
    expect(Object.keys(message["source"] as object)).toEqual(["modelId"]);
  });

  it("still writes no source at all when the ctx carries no model", () => {
    const message = assistantMessage({ tools: [], providerId: "deepseek-official" });
    expect(message["source"]).toBeUndefined();
  });
});
