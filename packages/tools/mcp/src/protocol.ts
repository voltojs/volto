/**
 * MCP JSON-RPC 2.0 protocol types — subset used by the client.
 * These mirror the MCP specification's wire format without importing
 * the full MCP SDK (keeping @agent-core/core zero-dep invariant).
 */

// ── JSON-RPC 2.0 base ──────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ── MCP tool types ──────────────────────────────

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>; // JSON Schema object
}

export interface McpToolCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

// ── MCP resource / prompt types ─────────────────

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpPromptResult {
  messages: Array<{ role: string; content: { type: string; text?: string } }>;
}
