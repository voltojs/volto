/**
 * McpConnection — manages a single MCP server connection over a transport.
 * Handles request/response correlation, tool discovery, and tool invocation.
 */

import type { ToolDefinition, ToolResult, JSONSchema } from "@voltojs/core";
import type { McpTool, McpToolCallResult, McpResource, McpPrompt, McpPromptResult } from "./protocol.js";
import type { McpTransport } from "./transport.js";

export interface McpConnectionOptions {
  /** Unique identifier for this server */
  serverId: string;
  /** The transport to communicate over */
  transport: McpTransport;
}

export class McpConnection {
  private _tools: McpTool[] = [];
  private _resources: McpResource[] = [];
  private _prompts: McpPrompt[] = [];
  private _connected = false;

  constructor(private readonly options: McpConnectionOptions) {}

  get serverId(): string {
    return this.options.serverId;
  }

  get connected(): boolean {
    return this._connected;
  }

  get tools(): McpTool[] {
    return this._tools;
  }

  get resources(): McpResource[] {
    return this._resources;
  }

  get prompts(): McpPrompt[] {
    return this._prompts;
  }

  /** Connect the transport, perform MCP handshake, and discover tools/resources/prompts */
  async connect(): Promise<void> {
    const { transport } = this.options;
    await transport.connect();
    this._connected = true;
    await this.discover();
  }

  /** Disconnect the transport */
  async disconnect(): Promise<void> {
    this._connected = false;
    this._tools = [];
    this._resources = [];
    this._prompts = [];
    await this.options.transport.disconnect();
  }

  /** Re-discover tools, resources, and prompts from the server */
  async discover(): Promise<void> {
    if (!this._connected) return;

    try {
      const result = await this.options.transport.request("tools/list") as { tools?: McpTool[] };
      this._tools = result.tools ?? [];
    } catch {
      this._tools = [];
    }

    try {
      const result = await this.options.transport.request("resources/list") as { resources?: McpResource[] };
      this._resources = result.resources ?? [];
    } catch {
      this._resources = [];
    }

    try {
      const result = await this.options.transport.request("prompts/list") as { prompts?: McpPrompt[] };
      this._prompts = result.prompts ?? [];
    } catch {
      this._prompts = [];
    }
  }

  /** Call a tool on this MCP server */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this._connected) {
      return { modelContent: `MCP server "${this.serverId}" is not connected`, isError: true };
    }

    try {
      const result = (await this.options.transport.request("tools/call", {
        name,
        arguments: args,
      })) as McpToolCallResult;

      // Flatten content blocks into a single modelContent string
      const parts = result.content
        .map((block) => {
          if (block.type === "text" && block.text !== undefined) return block.text;
          if (block.type === "image") return `[image: ${block.mimeType ?? "unknown"}]`;
          return `[${block.type}]`;
        })
        .join("\n");

      return {
        modelContent: parts || "(empty result)",
        isError: result.isError,
        displayMetadata: { serverId: this.serverId, mcpResult: result },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        modelContent: `MCP tool call "${name}" failed on server "${this.serverId}": ${message}`,
        isError: true,
      };
    }
  }

  /** Read a resource from this MCP server */
  async readResource(uri: string): Promise<ToolResult> {
    if (!this._connected) {
      return { modelContent: `MCP server "${this.serverId}" is not connected`, isError: true };
    }

    try {
      const result = (await this.options.transport.request("resources/read", { uri })) as {
        contents?: Array<{ text?: string; mimeType?: string }>;
      };

      const text = result.contents?.map((c) => c.text ?? "").join("\n") ?? "";
      return {
        modelContent: text || "(empty resource)",
        displayMetadata: { serverId: this.serverId, uri },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        modelContent: `MCP resource read "${uri}" failed: ${message}`,
        isError: true,
      };
    }
  }

  /** Get a prompt from this MCP server */
  async getPrompt(name: string, args?: Record<string, string>): Promise<ToolResult> {
    if (!this._connected) {
      return { modelContent: `MCP server "${this.serverId}" is not connected`, isError: true };
    }

    try {
      const result = (await this.options.transport.request("prompts/get", {
        name,
        arguments: args,
      })) as McpPromptResult;

      const text = result.messages
        .map((m) => m.content.text ?? "")
        .join("\n");
      return {
        modelContent: text || "(empty prompt)",
        displayMetadata: { serverId: this.serverId, promptName: name },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        modelContent: `MCP prompt "${name}" failed: ${message}`,
        isError: true,
      };
    }
  }

  /** Convert discovered MCP tools to core ToolDefinition[], adding mcp:<serverId> capability */
  toToolDefinitions(): ToolDefinition[] {
    const capability = `mcp:${this.serverId}`;
    return this._tools.map((tool) => ({
      name: `mcp__${this.serverId}__${tool.name}`,
      description: tool.description ?? `MCP tool: ${tool.name}`,
      inputSchema: tool.inputSchema as unknown as JSONSchema,
      requires: [capability],
      riskTier: "READ_ONLY" as const,
      trust: "untrusted" as const,
    }));
  }

  /** Convert discovered resources into one read-only, index-addressed tool per resource. */
  toResourceToolDefinitions(): ToolDefinition[] {
    const capability = `mcp:${this.serverId}`;
    return this._resources.map((resource, i) => ({
      name: `mcp__${this.serverId}__read_resource_${i}`,
      description: `Read MCP resource "${resource.name}"${resource.description ? `: ${resource.description}` : ""} (${resource.uri})`,
      inputSchema: { type: "object", properties: {} } as unknown as JSONSchema,
      requires: [capability],
      riskTier: "READ_ONLY" as const,
      trust: "untrusted" as const,
    }));
  }

  /** Convert discovered prompts into one index-addressed tool per prompt, with the prompt's declared arguments as the tool's input schema. */
  toPromptToolDefinitions(): ToolDefinition[] {
    const capability = `mcp:${this.serverId}`;
    return this._prompts.map((prompt, i) => {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const arg of prompt.arguments ?? []) {
        properties[arg.name] = { type: "string", description: arg.description };
        if (arg.required) required.push(arg.name);
      }
      return {
        name: `mcp__${this.serverId}__get_prompt_${i}`,
        description: `Get MCP prompt "${prompt.name}"${prompt.description ? `: ${prompt.description}` : ""}`,
        inputSchema: { type: "object", properties, ...(required.length > 0 ? { required } : {}) } as unknown as JSONSchema,
        requires: [capability],
        riskTier: "READ_ONLY" as const,
        trust: "untrusted" as const,
      };
    });
  }

  /** Read a resource by its index in the last discover() result. */
  async readResourceByIndex(index: number): Promise<ToolResult> {
    const resource = this._resources[index];
    if (!resource) return { modelContent: `Unknown resource index: ${index}`, isError: true };
    return this.readResource(resource.uri);
  }

  /** Get a prompt by its index in the last discover() result. */
  async getPromptByIndex(index: number, args?: Record<string, string>): Promise<ToolResult> {
    const prompt = this._prompts[index];
    if (!prompt) return { modelContent: `Unknown prompt index: ${index}`, isError: true };
    return this.getPrompt(prompt.name, args);
  }
}
