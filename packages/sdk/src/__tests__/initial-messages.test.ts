import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import type { ModelPort, Message } from "@volto/core";

function makeModelPort(response: { type: "text"; text: string }): ModelPort {
  return {
    async *stream() {
      yield { type: "text_delta", text: response.text };
      yield { type: "done", stopReason: "end_turn" };
    },
  } as unknown as ModelPort;
}

describe("createAgent initialMessages", () => {
  it("seeds the first turn's message history with initialMessages", async () => {
    const priorHistory: Message[] = [
      { role: "user", content: "第一条历史消息" },
      { role: "assistant", content: [{ type: "text", text: "第一条回复" }], stopReason: "end_turn" },
    ];
    const agent = createAgent({
      modelPort: makeModelPort({ type: "text", text: "第二条回复" }),
      initialMessages: priorHistory,
    });

    const finalState = await agent.run("第二条消息");

    // Message order: priorHistory(2) + this turn's permission-boundary
    // reminder(1, first turn always announces since createAgent always
    // resolves a permissionConfig) + this turn's user(1) + assistant(1).
    expect(finalState.messages).toHaveLength(5);
    expect(finalState.messages[0]).toEqual(priorHistory[0]);
    expect(finalState.messages[1]).toEqual(priorHistory[1]);
    expect(finalState.messages[2]).toMatchObject({ role: "user" });
    expect(finalState.messages[3]).toEqual({ role: "user", content: "第二条消息" });
  });

  it("puts systemPrompt before initialMessages when both are provided", async () => {
    const agent = createAgent({
      modelPort: makeModelPort({ type: "text", text: "ok" }),
      systemPrompt: "你是一个助手",
      initialMessages: [{ role: "user", content: "历史消息" }],
    });

    const finalState = await agent.run("你好");

    expect(finalState.messages[0]).toEqual({ role: "system", content: "你是一个助手" });
    expect(finalState.messages[1]).toEqual({ role: "user", content: "历史消息" });
  });
});
