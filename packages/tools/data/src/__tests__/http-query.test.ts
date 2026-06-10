import { describe, it, expect } from "vitest";
import type { Network } from "@agent-core/core";
import { createHttpQueryTool } from "../index.js";

function createMockNetwork(statusCode: number, body: string, headers?: Record<string, string>): Network {
  return {
    async fetch() {
      return { status: statusCode, headers: headers ?? {}, body };
    },
  };
}

describe("http_query", () => {
  it("returns structured response with status and body", async () => {
    const network = createMockNetwork(200, '{"ok":true}');
    const tool = createHttpQueryTool(network);
    const result = await tool.handler({ url: "https://api.example.com/data" });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("HTTP 200");
    expect(result.modelContent).toContain('{"ok":true}');
    expect(result.displayMetadata).toMatchObject({ status: 200 });
  });

  it("returns isError on network failure", async () => {
    const network: Network = {
      async fetch() { throw new Error("connection refused"); },
    };
    const tool = createHttpQueryTool(network);
    const result = await tool.handler({ url: "https://fail.test" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("connection refused");
  });

  it("passes custom method and headers", async () => {
    let receivedUrl = "";
    let receivedMethod = "";
    const network: Network = {
      async fetch(req) {
        receivedUrl = req.url;
        receivedMethod = req.method ?? "GET";
        return { status: 200, headers: {}, body: "ok" };
      },
    };
    const tool = createHttpQueryTool(network);
    await tool.handler({
      url: "https://api.test",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"x":1}',
    });
    expect(receivedUrl).toBe("https://api.test");
    expect(receivedMethod).toBe("POST");
  });

  it("has network:fetch capability requirement", () => {
    const tool = createHttpQueryTool(createMockNetwork(200, ""));
    expect(tool.definition.requires).toContain("network:fetch");
  });
});
