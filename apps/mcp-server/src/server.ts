/**
 * MCP Server — exposes volto as an MCP tool.
 *
 * Registers `agent_run` tool that can be discovered and called by any MCP client.
 * Uses stdio transport for communication.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createWiredAgent } from "./wiring.js";
import { createMcpEventSink } from "./event-sink.js";
import type { WiringOptions } from "./wiring.js";

export type McpServerOptions = WiringOptions;

export function createMcpServer(opts: McpServerOptions = {}): Server {
  const server = new Server(
    { name: "volto", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  const eventSink = createMcpEventSink((notification, params) => {
    server.notification({ method: notification, params });
  });

  const agent = createWiredAgent({ ...opts, eventSink });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "agent_run",
        description: "Run the agent with a message and return the final response",
        inputSchema: {
          type: "object" as const,
          properties: {
            message: {
              type: "string",
              description: "The user message to send to the agent",
            },
          },
          required: ["message"],
        },
      },
      {
        name: "agent_stream",
        description: "Run the agent with a message and stream events via MCP notifications, returning the final response",
        inputSchema: {
          type: "object" as const,
          properties: {
            message: {
              type: "string",
              description: "The user message to send to the agent",
            },
          },
          required: ["message"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (name !== "agent_run" && name !== "agent_stream") {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const args = request.params.arguments as { message: string };
    try {
      const state = await agent.run(args.message);
      const messages = state.messages;
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      const responseText =
        typeof lastAssistant?.content === "string"
          ? lastAssistant.content
          : Array.isArray(lastAssistant?.content)
            ? lastAssistant.content
                .filter((b) => b.type === "text")
                .map((b) => (b.type === "text" ? b.text : ""))
                .join("")
            : "No response";

      return {
        content: [{ type: "text", text: responseText }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Agent error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// Start server when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server running on stdio");
}
