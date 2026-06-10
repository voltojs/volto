import { describe, it, expect, vi } from "vitest";
import { McpConnection } from "../connection.js";
import type { McpTransport } from "../transport.js";
import type { JsonRpcMessage } from "../protocol.js";

/**
 * Mock transport that captures outgoing messages and allows manual response injection.
 */
function createMockTransport(): McpTransport & {
  respondTo: (id: number | string, result: unknown) => void;
  lastRequest: () => { method: string; params?: Record<string, unknown> } | null;
} {
  const listeners: Array<(msg: JsonRpcMessage) => void> = [];
  let lastReq: { method: string; params?: Record<string, unknown> } | null = null;

  return {
    connected: true,
    async connect() {},
    async disconnect() {},
    async send(msg: JsonRpcMessage) {
      if ("method" in msg && "id" in msg) {
        lastReq = { method: msg.method, params: msg.params };
      }
    },
    onMessage(cb) {
      listeners.push(cb);
      return () => {
        const idx = listeners.indexOf(cb);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    async request(method, params) {
      lastReq = { method, params };
      return { tools: [] };
    },
    async notify() {},
    respondTo(id, result) {
      for (const l of listeners) {
        l({ jsonrpc: "2.0", id, result } as JsonRpcMessage);
      }
    },
    lastRequest() {
      return lastReq;
    },
  };
}

describe("McpConnection", () => {
  it("discovers tools from server on connect", async () => {
    const transport = createMockTransport();
    transport.request = vi.fn(async (method: string) => {
      if (method === "tools/list") return { tools: [{ name: "echo", description: "Echo tool", inputSchema: { type: "object" } }] };
      if (method === "resources/list") return { resources: [] };
      if (method === "prompts/list") return { prompts: [] };
      return {};
    });

    const conn = new McpConnection({ serverId: "test", transport });
    await conn.connect();

    expect(conn.connected).toBe(true);
    expect(conn.tools).toHaveLength(1);
    expect(conn.tools[0]!.name).toBe("echo");
  });

  it("maps MCP tools to ToolDefinition with mcp:<serverId> capability", async () => {
    const transport = createMockTransport();
    transport.request = vi.fn(async (method: string) => {
      if (method === "tools/list") return { tools: [{ name: "greet", description: "Say hello", inputSchema: { type: "object", properties: { name: { type: "string" } } } }] };
      if (method === "resources/list") return { resources: [] };
      if (method === "prompts/list") return { prompts: [] };
      return {};
    });

    const conn = new McpConnection({ serverId: "myserver", transport });
    await conn.connect();

    const defs = conn.toToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe("mcp__myserver__greet");
    expect(defs[0]!.requires).toEqual(["mcp:myserver"]);
    expect(defs[0]!.description).toBe("Say hello");
  });

  it("callTool forwards to transport and returns normalized ToolResult", async () => {
    const transport = createMockTransport();
    transport.request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "tools/list") return { tools: [{ name: "echo", description: "", inputSchema: { type: "object" } }] };
      if (method === "resources/list") return { resources: [] };
      if (method === "prompts/list") return { prompts: [] };
      if (method === "tools/call") return { content: [{ type: "text", text: `Echo: ${(params as { arguments?: Record<string, unknown> })?.arguments?.msg ?? ""}` }] };
      return {};
    });

    const conn = new McpConnection({ serverId: "test", transport });
    await conn.connect();
    const result = await conn.callTool("echo", { msg: "hello" });

    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toBe("Echo: hello");
    expect(result.displayMetadata).toMatchObject({ serverId: "test" });
  });

  it("callTool returns isError when server is disconnected", async () => {
    const transport = createMockTransport();
    const conn = new McpConnection({ serverId: "test", transport });
    // Don't connect
    const result = await conn.callTool("echo", {});
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("not connected");
  });

  it("callTool returns isError on exception (not throw)", async () => {
    const transport = createMockTransport();
    transport.request = vi.fn(async (method: string) => {
      if (method === "tools/list") return { tools: [] };
      if (method === "resources/list") return { resources: [] };
      if (method === "prompts/list") return { prompts: [] };
      if (method === "tools/call") throw new Error("server crashed");
      return {};
    });

    const conn = new McpConnection({ serverId: "test", transport });
    await conn.connect();
    const result = await conn.callTool("echo", {});

    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("server crashed");
  });

  it("disconnect clears tools and marks as disconnected", async () => {
    const transport = createMockTransport();
    transport.request = vi.fn(async (method: string) => {
      if (method === "tools/list") return { tools: [{ name: "x", description: "", inputSchema: {} }] };
      if (method === "resources/list") return { resources: [] };
      if (method === "prompts/list") return { prompts: [] };
      return {};
    });

    const conn = new McpConnection({ serverId: "test", transport });
    await conn.connect();
    expect(conn.tools).toHaveLength(1);

    await conn.disconnect();
    expect(conn.connected).toBe(false);
    expect(conn.tools).toHaveLength(0);
  });

  it("readResource returns normalized ToolResult", async () => {
    const transport = createMockTransport();
    transport.request = vi.fn(async (method: string) => {
      if (method === "tools/list") return { tools: [] };
      if (method === "resources/list") return { resources: [] };
      if (method === "prompts/list") return { prompts: [] };
      if (method === "resources/read") return { contents: [{ text: "file content here", mimeType: "text/plain" }] };
      return {};
    });

    const conn = new McpConnection({ serverId: "test", transport });
    await conn.connect();
    const result = await conn.readResource("file:///test.txt");

    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toBe("file content here");
  });

  it("getPrompt returns normalized ToolResult", async () => {
    const transport = createMockTransport();
    transport.request = vi.fn(async (method: string) => {
      if (method === "tools/list") return { tools: [] };
      if (method === "resources/list") return { resources: [] };
      if (method === "prompts/list") return { prompts: [] };
      if (method === "prompts/get") return { messages: [{ role: "user", content: { type: "text", text: "Hello!" } }] };
      return {};
    });

    const conn = new McpConnection({ serverId: "test", transport });
    await conn.connect();
    const result = await conn.getPrompt("greeting");

    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toBe("Hello!");
  });
});
