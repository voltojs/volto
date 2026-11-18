import { describe, expect, it } from "vitest";
import { textScript } from "@voltojs/core";
import type { ModelPort, ModelRequest, Network } from "@voltojs/core";
import { createNetworkToolExecutor } from "@voltojs/runtime-node";
import { createAgent } from "../create-agent.js";

const network: Network = {
  async fetch() {
    return { status: 200, headers: {}, body: '{"results":[]}' };
  },
};

async function visibleTools(webSearch?: Parameters<typeof createAgent>[0]["webSearch"]): Promise<string[]> {
  const requests: ModelRequest[] = [];
  const modelPort: ModelPort = {
    async *stream(req) {
      requests.push(req);
      yield* textScript("ok");
    },
  };
  const agent = createAgent({
    modelPort,
    network,
    ...(webSearch !== undefined ? { webSearch } : {}),
  });
  await agent.run("go");
  return requests[0]!.tools.map((tool) => tool.name);
}

describe("web_search assembly", () => {
  it("registers web_search with a configured source", async () => {
    const tools = await visibleTools({
      source: "glm",
      sourceId: "glm",
      label: "GLM",
      apiKey: "k",
    });
    expect(tools).toContain("web_search");
  });

  it("does not register web_search when the source is off", async () => {
    const tools = await visibleTools({ source: "off" });
    expect(tools).not.toContain("web_search");
  });

  it("still registers web_search with guidance when nothing is configured", async () => {
    const tools = await visibleTools({ source: "none" });
    expect(tools).toContain("web_search");
  });
});

describe("network tool executor", () => {
  it("answers with guidance instead of reaching the network when the source is none", async () => {
    const calls: string[] = [];
    const executor = createNetworkToolExecutor({
      network: {
        async fetch(req) {
          calls.push(req.url);
          return { status: 200, headers: {}, body: "{}" };
        },
      },
      webSearch: { source: "none" },
    });
    const result = await executor({ callId: "c1", name: "web_search", input: { query: "q" }, orderInBatch: 0 }, {
      readFiles: [],
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("drops web_search entirely when the source is off", async () => {
    const executor = createNetworkToolExecutor({
      network,
      webSearch: { source: "off" },
    });
    const result = await executor({ callId: "c1", name: "web_search", input: { query: "q" }, orderInBatch: 0 }, {
      readFiles: [],
    });
    expect(result.isError).toBe(true);
    expect(String(result.modelContent)).toContain("Unknown tool");
  });
});
