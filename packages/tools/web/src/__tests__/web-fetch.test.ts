import { describe, it, expect } from "vitest";
import type { Network } from "@volto/core";
import { createWebFetchTool, createWebSearchTool, CAP_NETWORK_FETCH } from "../index.js";

function mockNetwork(responseBody: string, status = 200): Network {
  return {
    async fetch() {
      return { status, headers: { "content-type": "text/plain" }, body: responseBody };
    },
  };
}

describe("web_fetch tool", () => {
  it("fetches a URL and returns body text", async () => {
    const tool = createWebFetchTool(mockNetwork("Hello, world!"));
    const result = await tool.handler({ url: "https://example.com" });
    expect(result.modelContent).toBe("Hello, world!");
    expect(result.displayMetadata?.status).toBe(200);
  });

  it("returns error on network failure", async () => {
    const failingNetwork: Network = {
      async fetch() { throw new Error("Connection refused"); },
    };
    const tool = createWebFetchTool(failingNetwork);
    const result = await tool.handler({ url: "https://unreachable.com" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("Connection refused");
  });

  it("definition requires network:fetch and has READ_ONLY risk", () => {
    const tool = createWebFetchTool(mockNetwork(""));
    expect(tool.definition.requires).toEqual([CAP_NETWORK_FETCH]);
    expect(tool.definition.riskTier).toBe("READ_ONLY");
  });
});

describe("web_search tool", () => {
  it("searches and returns results", async () => {
    const tool = createWebSearchTool(mockNetwork('{"results": []}'));
    const result = await tool.handler({ query: "test query" });
    expect(result.modelContent).toContain("results");
  });

  it("returns error on search failure", async () => {
    const failingNetwork: Network = {
      async fetch() { throw new Error("Timeout"); },
    };
    const tool = createWebSearchTool(failingNetwork);
    const result = await tool.handler({ query: "failing" });
    expect(result.isError).toBe(true);
  });
});
