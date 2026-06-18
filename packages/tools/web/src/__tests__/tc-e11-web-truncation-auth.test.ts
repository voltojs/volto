import { describe, it, expect } from "vitest";
import type { Network, NetworkRequest, NetworkResponse } from "@volto/core";
import { createWebFetchTool, createWebSearchTool } from "../index.js";

describe("TC-E11: web_fetch 输出截断 + web_search 认证头", () => {
  it("web_fetch truncates body exceeding OUTPUT_LIMIT (100_000 chars)", async () => {
    const bigBody = "A".repeat(200_000);
    const mockNetwork: Network = {
      async fetch(): Promise<NetworkResponse> {
        return {
          status: 200,
          headers: { "content-type": "text/plain" },
          body: bigBody,
        };
      },
    };

    const tool = createWebFetchTool(mockNetwork);
    const result = await tool.handler({ url: "https://example.com" });

    expect(result.isError).toBeFalsy();
    // modelContent must be truncated + truncation note.
    expect(result.modelContent).toContain("truncated");
    expect(result.modelContent!.length).toBeLessThan(110_000);
    expect(result.displayMetadata?.truncated).toBe(true);
    expect(result.displayMetadata?.bodyLength).toBe(200_000);
  });

  it("web_fetch does NOT truncate when body is under the limit", async () => {
    const smallBody = "Hello, world!";
    const mockNetwork: Network = {
      async fetch(): Promise<NetworkResponse> {
        return {
          status: 200,
          headers: {},
          body: smallBody,
        };
      },
    };

    const tool = createWebFetchTool(mockNetwork);
    const result = await tool.handler({ url: "https://example.com" });

    expect(result.modelContent).toBe("Hello, world!");
    expect(result.displayMetadata?.truncated).toBe(false);
  });

  it("web_search injects X-Subscription-Token header when apiKey is provided", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    const mockNetwork: Network = {
      async fetch(req: NetworkRequest): Promise<NetworkResponse> {
        capturedHeaders = req.headers;
        return {
          status: 200,
          headers: {},
          body: '{"results":[]}',
        };
      },
    };

    const tool = createWebSearchTool(mockNetwork, { apiKey: "test-key" });
    await tool.handler({ query: "test" });

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!["X-Subscription-Token"]).toBe("test-key");
  });

  it("web_search does NOT inject auth header when apiKey is omitted", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    const mockNetwork: Network = {
      async fetch(req: NetworkRequest): Promise<NetworkResponse> {
        capturedHeaders = req.headers;
        return {
          status: 200,
          headers: {},
          body: '{"results":[]}',
        };
      },
    };

    const tool = createWebSearchTool(mockNetwork);
    await tool.handler({ query: "test" });

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!["X-Subscription-Token"]).toBeUndefined();
  });
});
