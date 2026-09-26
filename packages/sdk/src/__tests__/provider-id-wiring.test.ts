/**
 * 路由溯源透传（spec 2026-09-26 §3.3）：宿主给的 provider 配置 id 必须到达
 * StepContext，从而写进每条 assistant_message 的 source —— 主 agent 与委派
 * 出去的子 agent 都要成立（子会话的用量卡片也要有「提供方」）。
 */
import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import type { AgentSpec } from "../agent-spec.js";
import type { AgentEntry } from "../agent-registry/scan.js";
import type { TranscriptEventInput } from "@volto/core";
import { createMockModelPort, textScript, toolCallScript } from "@volto/core";

function agentEntry(spec: AgentSpec): AgentEntry {
  return { id: `plugin:${spec.name}`, scope: "plugin", spec, shadowed: false };
}

describe("providerId pass-through", () => {
  it("stamps the host's provider id onto the assistant message source", async () => {
    const agent = createAgent({
      modelPort: createMockModelPort([textScript("hi", 10, 2)]),
      model: "deepseek-flash",
      providerId: "deepseek-official",
    });

    await agent.run("hello");

    const assistant = agent.getState().messages.filter((m) => m.role === "assistant");
    expect(assistant.at(-1)!.source).toEqual({
      providerId: "deepseek-official",
      modelId: "deepseek-flash",
    });
  });

  it("leaves source without a providerId key when the host supplies none", async () => {
    const agent = createAgent({
      modelPort: createMockModelPort([textScript("hi", 10, 2)]),
      model: "deepseek-flash",
    });

    await agent.run("hello");

    const assistant = agent.getState().messages.filter((m) => m.role === "assistant");
    expect(assistant.at(-1)!.source).toEqual({ modelId: "deepseek-flash" });
  });

  it("carries the same route into a delegated child's transcript", async () => {
    const written: Array<{ sessionId: string; event: TranscriptEventInput }> = [];
    const chatStore = {
      async appendEvents(sessionId: string, events: TranscriptEventInput[]) {
        for (const event of events) written.push({ sessionId, event });
      },
    };

    const agent = createAgent({
      modelPort: createMockModelPort([
        toolCallScript(
          "c1",
          "task",
          JSON.stringify({ message: "search", subagent_type: "searcher" }),
        ),
        textScript("child done"),
        textScript("parent done"),
      ]),
      model: "deepseek-flash",
      providerId: "deepseek-official",
      enableTaskTool: true,
      agentSpecs: [agentEntry({ name: "searcher" })],
      chatStore,
      chatSessionId: "s1",
    });

    await agent.run("delegate this");

    // 子会话 id 由默认 Id port 以 `${parent}-sub-` 为前缀派生：这里是
    // `s1-sub-` 拼上 Id 生成的 id 前缀，不是裸计数器。断言只依赖该前缀。
    const childAssistant = written.find(
      (w) => w.sessionId.startsWith("s1-sub-") && w.event.type === "assistant_message",
    );
    expect(childAssistant).toBeDefined();
    expect(childAssistant!.event.data).toMatchObject({
      source: { providerId: "deepseek-official", modelId: "deepseek-flash" },
    });
  });
});
