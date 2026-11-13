/**
 * McpToolSource — implements the core ToolSource port for MCP connections.
 *
 * Manages one or more MCP server connections, aggregates their tools into
 * ToolDefinition[], exposes resources/prompts as controlled tools, and
 * notifies the SDK of tool set changes via onChange().
 *
 * Server capabilities (mcp:<serverId>) are added/removed on connect/disconnect,
 * enabling the existing filterVisibleTools capability gating to automatically
 * show/hide tools.
 */

import type { ToolSource, ToolDefinition, ToolResult, RiskTier } from "@voltojs/core";
import { McpConnection } from "./connection.js";
import type { McpTransport } from "./transport.js";

export interface McpServerConfig {
  /** Unique server identifier (used in mcp:<serverId> capability and tool name prefix) */
  serverId: string;
  /** Transport instance for this server */
  transport: McpTransport;
  /**
   * Risk tier for this server's tools; defaults to WRITE_HIGH so an unknown
   * MCP call reaches the permission matrix (ask / prune) instead of being
   * assumed read-only. A trusted server can be graded lower explicitly.
   */
  riskTier?: RiskTier;
}

export interface McpToolSourceOptions {
  /** MCP server configurations */
  servers: McpServerConfig[];
  /**
   * Available capabilities set — server capabilities (mcp:<serverId>)
   * are added/removed on connect/disconnect. If not provided, a
   * default Set is created internally.
   */
  capabilities?: Set<string>;
}

export class McpToolSource implements ToolSource {
  private readonly connections = new Map<string, McpConnection>();
  private readonly capabilities: Set<string>;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: McpToolSourceOptions) {
    this.capabilities = options.capabilities ?? new Set<string>();

    for (const server of options.servers) {
      const connection = new McpConnection({
        serverId: server.serverId,
        transport: server.transport,
        ...(server.riskTier !== undefined ? { riskTier: server.riskTier } : {}),
      });
      this.connections.set(server.serverId, connection);
    }
  }

  /** Connect all configured MCP servers */
  async connectAll(): Promise<void> {
    for (const [serverId, connection] of this.connections) {
      try {
        await connection.connect();
        this.capabilities.add(`mcp:${serverId}`);
      } catch {
        // Server failed to connect — capability not added, tools will not be visible
      }
    }
    this.notify();
  }

  /** Disconnect a specific server */
  async disconnectServer(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;

    await connection.disconnect();
    this.capabilities.delete(`mcp:${serverId}`);
    this.notify();
  }

  /** Disconnect all servers */
  async disconnectAll(): Promise<void> {
    for (const [serverId, connection] of this.connections) {
      await connection.disconnect();
      this.capabilities.delete(`mcp:${serverId}`);
    }
    this.notify();
  }

  /**
   * ToolSource.list() — returns ToolDefinitions from all connected MCP servers,
   * plus controlled tools for resources/prompts.
   */
  async list(): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [];

    for (const [, connection] of this.connections) {
      if (!connection.connected) continue;

      tools.push(...connection.toToolDefinitions());
      tools.push(...connection.toResourceToolDefinitions());
      tools.push(...connection.toPromptToolDefinitions());
    }

    return tools;
  }

  /**
   * ToolSource.onChange() — subscribe to tool set changes.
   * Fires when servers connect/disconnect or tool lists change.
   */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Call an MCP tool by its full prefixed name */
  async callTool(fullName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const { serverId, toolName } = parseMcpToolName(fullName);
    const connection = this.connections.get(serverId);
    if (!connection) {
      return { modelContent: `Unknown MCP server: ${serverId}`, isError: true };
    }

    const resourceMatch = /^read_resource_(\d+)$/.exec(toolName);
    if (resourceMatch) {
      return connection.readResourceByIndex(Number(resourceMatch[1]));
    }
    const promptMatch = /^get_prompt_(\d+)$/.exec(toolName);
    if (promptMatch) {
      const stringArgs = Object.fromEntries(
        Object.entries(args).map(([k, v]) => [k, String(v)]),
      );
      return connection.getPromptByIndex(Number(promptMatch[1]), stringArgs);
    }

    return connection.callTool(toolName, args);
  }

  /** Read an MCP resource */
  async readResource(serverId: string, uri: string): Promise<ToolResult> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      return { modelContent: `Unknown MCP server: ${serverId}`, isError: true };
    }
    return connection.readResource(uri);
  }

  /** Get an MCP prompt */
  async getPrompt(serverId: string, name: string, args?: Record<string, string>): Promise<ToolResult> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      return { modelContent: `Unknown MCP server: ${serverId}`, isError: true };
    }
    return connection.getPrompt(name, args);
  }

  /** Re-discover tools from a specific server and notify listeners */
  async refreshServer(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;

    try {
      await connection.discover();
      this.notify();
    } catch {
      // Discovery failure — tools may be stale, but server is still connected
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

// ── Helpers ──────────────────────────────────────

/** Parse "mcp__<serverId>__<toolName>" into { serverId, toolName } */
export function parseMcpToolName(fullName: string): { serverId: string; toolName: string } {
  // mcp__<serverId>__<toolName> — split from the right to handle serverId with underscores
  const prefix = "mcp__";
  if (!fullName.startsWith(prefix)) {
    throw new Error(`Not an MCP tool name: ${fullName}`);
  }
  const rest = fullName.slice(prefix.length);
  const separator = "__";
  const idx = rest.lastIndexOf(separator);
  if (idx < 0) {
    throw new Error(`Invalid MCP tool name format: ${fullName}`);
  }
  return {
    serverId: rest.slice(0, idx),
    toolName: rest.slice(idx + separator.length),
  };
}

/** Check if a tool name is an MCP tool */
export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__");
}
