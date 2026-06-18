import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server.js";
import type { WiringOptions } from "../wiring.js";
import type { ModelPort } from "@volto/core";

const MOCK_MODEL: ModelPort = {
  async *stream() {
    yield { type: "text_delta", text: "Hello from agent" };
    yield { type: "done", stopReason: "end_turn" };
  },
};

let server: ReturnType<typeof createMcpServer>;
let client: Client;

beforeAll(async () => {
  server = createMcpServer({ modelPort: MOCK_MODEL } as WiringOptions);
  client = new Client({ name: "test-client", version: "0.0.1" });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await server.close();
});

describe("MCP Server", () => {
  it("lists agent_run and agent_stream tools", async () => {
    const result = await client.listTools();
    expect(result.tools).toHaveLength(2);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["agent_run", "agent_stream"]);
    expect(result.tools[0]!.description).toContain("agent");
  });

  it("calls agent_run tool", async () => {
    const result = await client.callTool({
      name: "agent_run",
      arguments: { message: "hello" },
    });
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content.length).toBeGreaterThan(0);
    expect(content[0]!.text).toContain("Hello from agent");
    expect(result.isError).toBeFalsy();
  });

  it("calls agent_stream tool", async () => {
    const result = await client.callTool({
      name: "agent_stream",
      arguments: { message: "hello stream" },
    });
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content.length).toBeGreaterThan(0);
    expect(content[0]!.text).toContain("Hello from agent");
    expect(result.isError).toBeFalsy();
  });

  it("returns error for unknown tool", async () => {
    const result = await client.callTool({
      name: "unknown_tool",
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });
});
