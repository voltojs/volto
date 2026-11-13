import { describe, it, expect } from "vitest";
import type { Network } from "@voltojs/core";
import { renderTimeoutSignature } from "../../common/index.js";
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

  it("keeps the network layer's timeout signature verbatim in modelContent", async () => {
    // The network adapter surfaces its own timeout-abort as an Error whose
    // message is the unified timeout signature (byte-identical to
    // renderTimeoutSignature). The catch face must not mangle it.
    const url = "https://example.com/slow";
    const timeoutMs = 30_000;
    const signature = renderTimeoutSignature(url, timeoutMs);
    const timingOutNetwork: Network = {
      async fetch() {
        throw new Error(signature);
      },
    };
    const tool = createWebFetchTool(timingOutNetwork);
    const result = await tool.handler({ url });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toBe(`web_fetch failed: ${signature}`);
  });

  it("external abort surfaces no timeout signature (cancellation, not timeout)", async () => {
    // An externally-aborted fetch rejects with an AbortError whose message is
    // NOT the timeout signature — the catch face must not fabricate one.
    const abortedNetwork: Network = {
      async fetch() {
        const abortError = new Error("The operation was aborted.");
        abortError.name = "AbortError";
        throw abortError;
      },
    };
    const tool = createWebFetchTool(abortedNetwork);
    const result = await tool.handler({ url: "https://example.com" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).not.toContain("[timeout]");
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

  it("keeps the network layer's timeout signature verbatim in modelContent", async () => {
    const timeoutMs = 30_000;
    const signature = renderTimeoutSignature("https://api.search.brave.com/res/v1/web/search", timeoutMs);
    const timingOutNetwork: Network = {
      async fetch() {
        throw new Error(signature);
      },
    };
    const tool = createWebSearchTool(timingOutNetwork);
    const result = await tool.handler({ query: "timeout case" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toBe(`web_search failed: ${signature}`);
  });

  it("external abort surfaces no timeout signature (cancellation, not timeout)", async () => {
    const abortedNetwork: Network = {
      async fetch() {
        const abortError = new Error("The operation was aborted.");
        abortError.name = "AbortError";
        throw abortError;
      },
    };
    const tool = createWebSearchTool(abortedNetwork);
    const result = await tool.handler({ query: "aborted case" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).not.toContain("[timeout]");
  });
});
