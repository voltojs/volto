/**
 * McpTransport — abstract transport for MCP JSON-RPC communication.
 * Implementations handle the I/O (stdio, HTTP-SSE, etc.).
 */

import type { JsonRpcMessage } from "./protocol.js";

export interface McpTransport {
  /** Send a message to the MCP server */
  send(msg: JsonRpcMessage): Promise<void>;
  /** Subscribe to incoming messages. Returns an unsubscribe function. */
  onMessage(cb: (msg: JsonRpcMessage) => void): () => void;
  /** Connect the transport (start subprocess / open connection) */
  connect(): Promise<void>;
  /** Disconnect the transport (kill subprocess / close connection) */
  disconnect(): Promise<void>;
  /** Whether the transport is currently connected */
  readonly connected: boolean;
  /**
   * Send a JSON-RPC request and wait for the matching response.
   * Transports must correlate request id with response id.
   */
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Send a notification (no response expected) */
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
}
