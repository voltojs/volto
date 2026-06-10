/**
 * StdioTransport — MCP transport over child process stdin/stdout.
 * Spawns the server as a subprocess and communicates via newline-delimited JSON.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { JsonRpcMessage } from "./protocol.js";
import type { McpTransport } from "./transport.js";

export interface StdioTransportOptions {
  /** Command to spawn (e.g. "npx" or "/usr/bin/node") */
  command: string;
  /** Arguments for the command */
  args?: string[];
  /** Working directory */
  cwd?: string;
  /** Environment variables (merged with process.env) */
  env?: Record<string, string>;
  /** Timeout for the initial connection in ms (default: 30000) */
  timeoutMs?: number;
}

export class StdioTransport implements McpTransport {
  private process: ChildProcess | null = null;
  private messageListeners: Array<(msg: JsonRpcMessage) => void> = [];
  private _connected = false;

  constructor(private readonly options: StdioTransportOptions) {}

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    if (this._connected) return;

    const { command, args = [], cwd, env } = this.options;

    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: { ...process.env, ...env },
    });

    this.process.on("error", () => {
      this._connected = false;
    });

    this.process.on("exit", () => {
      this._connected = false;
    });

    // Parse newline-delimited JSON from stdout
    const rl = createInterface({ input: this.process.stdout! });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcMessage;
        for (const listener of this.messageListeners) {
          listener(msg);
        }
      } catch {
        // Ignore non-JSON lines (e.g. server debug output on stderr)
      }
    });

    this._connected = true;

    // Send an initialize request to verify the server is alive
    try {
      await this.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "agent-core-mcp-client", version: "0.0.1" },
      });
      // Send initialized notification
      await this.notify("notifications/initialized", {});
    } catch (err) {
      await this.disconnect();
      throw new Error(
        `MCP server initialization failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async disconnect(): Promise<void> {
    if (!this._connected && !this.process) return;
    this._connected = false;

    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  async send(msg: JsonRpcMessage): Promise<void> {
    if (!this._connected || !this.process?.stdin) {
      throw new Error("MCP transport not connected");
    }
    const data = JSON.stringify(msg) + "\n";
    this.process.stdin.write(data);
  }

  onMessage(cb: (msg: JsonRpcMessage) => void): () => void {
    this.messageListeners.push(cb);
    return () => {
      const idx = this.messageListeners.indexOf(cb);
      if (idx >= 0) this.messageListeners.splice(idx, 1);
    };
  }

  /** Send a request and wait for the matching response */
  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this._connected || !this.process?.stdin) {
      throw new Error("MCP transport not connected");
    }
    const id = nextId();
    const request = { jsonrpc: "2.0" as const, id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timeout = this.options.timeoutMs ?? 30000;
      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`MCP request "${method}" timed out after ${timeout}ms`));
      }, timeout);

      const unsub = this.onMessage((msg) => {
        if ("id" in msg && msg.id === id && "result" in msg) {
          clearTimeout(timer);
          unsub();
          if (msg.error) {
            reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
          } else {
            resolve(msg.result);
          }
        }
      });

      this.send(request).catch((err) => {
        clearTimeout(timer);
        unsub();
        reject(err);
      });
    });
  }

  /** Send a notification (no response expected) */
  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.send({ jsonrpc: "2.0", method, params });
  }
}

let _idCounter = 0;
function nextId(): number {
  return ++_idCounter;
}
