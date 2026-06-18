import { describe, it, expect, vi } from "vitest";
import { McpToolSource, parseMcpToolName, isMcpToolName } from "../mcp-tool-source.js";
import type { ToolSource } from "@volto/core";

/**
 * Mock transport that returns predetermined tools.
 */
function createMockTransport(tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> = []) {
  return {
    connected: true,
    async connect() {},
    async disconnect() {},
    async send() {},
    onMessage() { return () => {}; },
    async request(method: string) {
      if (method === "tools/list") return { tools };
      if (method === "resources/list") return { resources: [] };
      if (method === "prompts/list") return { prompts: [] };
      return {};
    },
    async notify() {},
  };
}

describe("parseMcpToolName", () => {
  it("parses mcp__<serverId>__<toolName> format", () => {
    expect(parseMcpToolName("mcp__fs-server__read_file")).toEqual({
      serverId: "fs-server",
      toolName: "read_file",
    });
  });

  it("handles serverId with underscores", () => {
    expect(parseMcpToolName("mcp__my__cool__server__echo")).toEqual({
      serverId: "my__cool__server",
      toolName: "echo",
    });
  });

  it("throws on non-MCP tool name", () => {
    expect(() => parseMcpToolName("read_file")).toThrow("Not an MCP tool name");
  });

  it("throws on malformed name", () => {
    expect(() => parseMcpToolName("mcp__noseparator")).toThrow("Invalid MCP tool name format");
  });
});

describe("isMcpToolName", () => {
  it("returns true for MCP-prefixed names", () => {
    expect(isMcpToolName("mcp__server__tool")).toBe(true);
  });

  it("returns false for non-MCP names", () => {
    expect(isMcpToolName("read_file")).toBe(false);
  });
});

describe("McpToolSource", () => {
  it("implements ToolSource interface (list + onChange)", () => {
    const transport = createMockTransport();
    const source = new McpToolSource({
      servers: [{ serverId: "test", transport }],
    });
    // Type guard: confirms it satisfies ToolSource
    const _: ToolSource = source;
    expect(typeof _.list).toBe("function");
    expect(typeof _.onChange).toBe("function");
  });

  it("connectAll adds mcp:<serverId> capability and lists tools", async () => {
    const transport = createMockTransport([
      { name: "echo", description: "Echo", inputSchema: { type: "object" } },
    ]);
    const capabilities = new Set<string>();
    const source = new McpToolSource({
      servers: [{ serverId: "srv1", transport }],
      capabilities,
    });

    await source.connectAll();
    expect(capabilities.has("mcp:srv1")).toBe(true);

    const tools = await source.list();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("mcp__srv1__echo");
    expect(tools[0]!.requires).toEqual(["mcp:srv1"]);
  });

  it("disconnectServer removes capability and tools", async () => {
    const transport = createMockTransport([
      { name: "echo", description: "Echo", inputSchema: {} },
    ]);
    const capabilities = new Set<string>();
    const source = new McpToolSource({
      servers: [{ serverId: "srv1", transport }],
      capabilities,
    });

    await source.connectAll();
    expect(capabilities.has("mcp:srv1")).toBe(true);

    await source.disconnectServer("srv1");
    expect(capabilities.has("mcp:srv1")).toBe(false);

    const tools = await source.list();
    expect(tools).toHaveLength(0);
  });

  it("callTool routes to correct server", async () => {
    const transport = createMockTransport([
      { name: "echo", description: "", inputSchema: {} },
    ]);

    // Override request to handle tools/call
    transport.request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "tools/list") return { tools: [{ name: "echo", description: "", inputSchema: {} }] };
      if (method === "resources/list") return { resources: [] };
      if (method === "prompts/list") return { prompts: [] };
      if (method === "tools/call") return { content: [{ type: "text", text: `ok: ${(params as { arguments?: Record<string, unknown> })?.arguments?.x}` }] };
      return {};
    }) as typeof transport.request;

    const source = new McpToolSource({
      servers: [{ serverId: "srv1", transport: transport as unknown as import("../transport.js").McpTransport }],
    });
    await source.connectAll();

    const result = await source.callTool("mcp__srv1__echo", { x: 42 });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("42");
  });

  it("onChange fires on connectAll", async () => {
    const transport = createMockTransport([{ name: "t", inputSchema: {} }]);
    const source = new McpToolSource({
      servers: [{ serverId: "s", transport }],
    });

    const cb = vi.fn();
    source.onChange(cb);
    await source.connectAll();
    expect(cb).toHaveBeenCalled();
  });

  it("disconnectAll removes all capabilities", async () => {
    const t1 = createMockTransport([{ name: "a", inputSchema: {} }]);
    const t2 = createMockTransport([{ name: "b", inputSchema: {} }]);
    const capabilities = new Set<string>();

    const source = new McpToolSource({
      servers: [
        { serverId: "s1", transport: t1 },
        { serverId: "s2", transport: t2 },
      ],
      capabilities,
    });

    await source.connectAll();
    expect(capabilities.size).toBe(2);

    await source.disconnectAll();
    expect(capabilities.size).toBe(0);
  });

  it("returns empty list when no servers connected", async () => {
    const source = new McpToolSource({ servers: [] });
    const tools = await source.list();
    expect(tools).toEqual([]);
  });

  it("callTool returns isError for unknown server", async () => {
    const source = new McpToolSource({ servers: [] });
    const result = await source.callTool("mcp__unknown__tool", {});
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("Unknown MCP server");
  });
});
