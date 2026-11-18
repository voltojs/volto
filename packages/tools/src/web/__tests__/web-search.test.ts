import { describe, it, expect } from "vitest";
import type { Network, NetworkRequest, NetworkResponse } from "@voltojs/core";
import { renderTimeoutSignature } from "../../common/index.js";
import { createWebSearchTool, type WebSearchToolOptions } from "../index.js";

function networkReturning(body: string, status = 200): Network & { calls: NetworkRequest[] } {
  const calls: NetworkRequest[] = [];
  return {
    calls,
    async fetch(req: NetworkRequest): Promise<NetworkResponse> {
      calls.push(req);
      return { status, headers: {}, body };
    },
  };
}

const deepseek: WebSearchToolOptions = {
  source: "deepseek",
  sourceId: "deepseek",
  label: "DeepSeek",
  apiKey: "k",
};

const deepseekBody = JSON.stringify({
  results: [{ title: "T", url: "https://e.com", summary: "S", snippet: "s", site_name: "E", date: "2026-06-01" }],
});

describe("web_search tool", () => {
  it("returns guidance without touching the network when the source is none", async () => {
    const network = networkReturning("{}");
    const tool = createWebSearchTool(network, { source: "none" });
    const result = await tool.handler({ query: "x" });
    expect(network.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("Settings");
    expect(result.modelContent).toContain("Tools");
  });

  it("renders hits for the model and metadata for the UI", async () => {
    const network = networkReturning(deepseekBody);
    const tool = createWebSearchTool(network, deepseek);
    const result = await tool.handler({ query: "q", numResults: 3 });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("1. T — https://e.com");
    expect(result.modelContent).toContain("S");
    expect(JSON.parse(network.calls[0]!.body!).count).toBe(3);
    const meta = result.displayMetadata!.webSearch as {
      sourceId: string;
      sourceLabel: string;
      count: number;
      hits: unknown[];
    };
    expect(meta.sourceId).toBe("deepseek");
    expect(meta.sourceLabel).toBe("DeepSeek");
    expect(meta.count).toBe(1);
    expect(meta.hits).toHaveLength(1);
  });

  it("says so when the source returned no hits", async () => {
    const tool = createWebSearchTool(networkReturning(JSON.stringify({ results: [] })), deepseek);
    const result = await tool.handler({ query: "nothing" });
    expect(result.isError).toBeFalsy();
    expect(String(result.modelContent).toLowerCase()).toContain("no matching results");
  });

  it("caps metadata hits at 10 and summaries at 240 characters", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      title: `T${i}`,
      url: `https://e.com/${i}`,
      summary: "s".repeat(500),
    }));
    const tool = createWebSearchTool(networkReturning(JSON.stringify({ results: many })), deepseek);
    const result = await tool.handler({ query: "q" });
    const meta = result.displayMetadata!.webSearch as { hits: Array<{ summary?: string }> };
    expect(meta.hits).toHaveLength(10);
    expect(meta.hits[0]!.summary).toHaveLength(240);
  });

  it("keeps the legacy apiUrl option working as a Brave endpoint", async () => {
    const network = networkReturning(JSON.stringify({ web: { results: [{ title: "T", url: "https://b.com" }] } }));
    const tool = createWebSearchTool(network, {
      source: "brave",
      sourceId: "brave",
      label: "Brave",
      apiKey: "k",
      apiUrl: "https://proxy.example.com/search",
    });
    await tool.handler({ query: "q" });
    expect(network.calls[0]!.url).toBe("https://proxy.example.com/search?q=q&count=5");
  });

  it("surfaces an egress denial as a network error naming the host", async () => {
    const denied = networkReturning('{"error":"network egress denied: api.search.brave.com"}', 403);
    const tool = createWebSearchTool(denied, { source: "brave", sourceId: "brave", label: "Brave", apiKey: "k" });
    const result = await tool.handler({ query: "q" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("api.search.brave.com");
  });

  it("reports auth errors with a pointer to settings", async () => {
    const tool = createWebSearchTool(networkReturning("{}", 401), {
      source: "glm",
      sourceId: "glm",
      label: "GLM",
      apiKey: "k",
    });
    const result = await tool.handler({ query: "q" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("GLM");
    expect(result.modelContent).toContain("Settings");
  });

  it("keeps the network layer's timeout signature verbatim", async () => {
    const signature = renderTimeoutSignature("https://api.search.brave.com/res/v1/web/search", 30_000);
    const tool = createWebSearchTool(
      {
        async fetch(): Promise<NetworkResponse> {
          throw new Error(signature);
        },
      },
      { source: "brave", sourceId: "brave", label: "Brave", apiKey: "k" },
    );
    const result = await tool.handler({ query: "timeout case" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toBe(`web_search failed: ${signature}`);
  });

  it("external abort surfaces no timeout signature (cancellation, not timeout)", async () => {
    const tool = createWebSearchTool(
      {
        async fetch(): Promise<NetworkResponse> {
          const abortError = new Error("The operation was aborted.");
          abortError.name = "AbortError";
          throw abortError;
        },
      },
      { source: "brave", sourceId: "brave", label: "Brave", apiKey: "k" },
    );
    const result = await tool.handler({ query: "aborted case" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).not.toContain("[timeout]");
  });
});
