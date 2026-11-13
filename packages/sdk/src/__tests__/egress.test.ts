// createAgent 的 egressPolicy 接线：策略必须真正包住 Network port 的全部
// 消费方（web_fetch / web_search / http_query 工具与 network 执行器）——
// 名单外主机拿到结构化 403 且适配器根本不被触达，名单内原样透传。
import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import { createMockModelPort, toolCallScript, textScript } from "@voltojs/core";
import type { Network, NetworkRequest, NetworkResponse } from "@voltojs/core";
import type { EgressPolicy } from "@voltojs/runtime-node";

function recordingNetwork(): { network: Network; requests: NetworkRequest[] } {
  const requests: NetworkRequest[] = [];
  return {
    requests,
    network: {
      async fetch(req: NetworkRequest): Promise<NetworkResponse> {
        requests.push(req);
        return { status: 200, headers: {}, body: "passed-through" };
      },
    },
  };
}

/** 跑一个只含一次 web_fetch 的回合，返回最终状态（工具结果在 messages 里）。 */
async function runWebFetch(
  network: Network,
  policy?: EgressPolicy,
  url = "https://target.example.com/x",
) {
  const mock = createMockModelPort([
    toolCallScript("c1", "web_fetch", JSON.stringify({ url })),
    textScript("done"),
  ]);
  const agent = createAgent({ modelPort: mock, network, egressPolicy: policy });
  return agent.run("go");
}

function toolResultText(state: unknown): string {
  const messages = (state as { messages?: Array<{ role: string; content: unknown }> })
    .messages ?? [];
  const tool = messages.filter((m) => m.role === "tool").at(-1);
  return JSON.stringify(tool?.content ?? "");
}

describe("createAgent — egressPolicy wraps the Network port", () => {
  it("denies a host outside the allowlist with a structured 403 and never reaches the adapter", async () => {
    const { network, requests } = recordingNetwork();
    const state = await runWebFetch(
      network,
      { allowHosts: ["allowed.example.com"] },
      "https://evil.example.com/x",
    );

    expect(requests).toHaveLength(0);
    const text = toolResultText(state);
    // 拒绝体进模型上下文；403 状态码走 displayMetadata（模型不可见）。
    expect(text).toContain("egress_denied");
    expect(text).toContain("evil.example.com");
  });

  it("passes an allowlisted host through to the adapter unchanged", async () => {
    const { network, requests } = recordingNetwork();
    const state = await runWebFetch(network, { allowHosts: ["target.example.com"] });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://target.example.com/x");
    expect(toolResultText(state)).toContain("passed-through");
  });

  it("leaves the network untouched when no policy is given", async () => {
    const { network, requests } = recordingNetwork();
    const state = await runWebFetch(network);

    expect(requests).toHaveLength(1);
    expect(toolResultText(state)).toContain("passed-through");
  });

  it("a dispatched sub-agent inherits the wrapped network (no raw-opts bypass)", async () => {
    const { network, requests } = recordingNetwork();
    // 子代理脚本：直接对名单外主机发 web_fetch。若继承断裂（裸 opts 透传），
    // 适配器会被触达（requests=1）；继承成立则请求在包装层被拒，适配器零命中。
    const mock = createMockModelPort([
      // 父：派发 fetcher 子代理
      toolCallScript("c1", "task", JSON.stringify({
        subagent_type: "fetcher",
        message: "fetch-dispatch-msg",
      })),
      // 子：对名单外主机 web_fetch（子代理的调用穿插在父两次调用之间）
      toolCallScript("c2", "web_fetch", JSON.stringify({ url: "https://evil.example.com/x" })),
      textScript("child done"),
      // 父：收齐结果后收尾
      textScript("parent done"),
    ]);
    const agent = createAgent({
      modelPort: mock,
      network,
      egressPolicy: { allowHosts: ["allowed.example.com"] },
      agentSpecs: [
        {
          id: "project:fetcher",
          scope: "project",
          spec: { name: "fetcher", tools: ["web_fetch"] },
          shadowed: false,
        },
      ],
    });
    const state = await agent.run("go");

    expect(requests).toHaveLength(0);
    const text = toolResultText(state);
    expect(text).toContain("egress_denied");
  });
});
