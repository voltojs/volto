/**
 * Node.js LSP client adapter — implements LspClient via child_process stdio.
 *
 * Launches a language server as a child process and communicates via
 * JSON-RPC over stdin/stdout (LSP protocol).
 *
 * The host must provide the command and arguments to launch the server
 * (e.g. `["typescript-language-server", "--stdio"]`).
 */

import { spawn, type ChildProcess } from "node:child_process";
import type {
  LspClient,
  LspLocation,
  LspReference,
} from "@volto/tools-code";

export interface NodeLspClientOptions {
  /** Language server command (e.g. "typescript-language-server") */
  command: string;
  /** Arguments to pass to the command (e.g. ["--stdio"]) */
  args?: string[];
  /** Working directory for the language server */
  cwd?: string;
  /** Optional initialization params sent in initialize request */
  initializationParams?: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
};

export async function createNodeLspClient(
  opts: NodeLspClientOptions,
): Promise<LspClient> {
  const proc: ChildProcess = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!proc.stdin || !proc.stdout) {
    throw new Error("Failed to start language server: stdin/stdout not available");
  }

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  // Content-Length framed reader
  let buffer = "";

  proc.stdout.on("data", onData);

  function onData(chunk: Buffer) {
    buffer += chunk.toString();
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const len = parseInt(match[1]!, 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + len) break;

      const body = buffer.slice(bodyStart, bodyStart + len);
      buffer = buffer.slice(bodyStart + len);

      try {
        const msg = JSON.parse(body) as JsonRpcResponse | JsonRpcNotification;
        if ("id" in msg && msg.id != null) {
          const p = pending.get(msg.id as number);
          if (p) {
            pending.delete(msg.id as number);
            if ("error" in msg && msg.error) {
              p.reject(new Error(msg.error.message));
            } else {
              p.resolve("result" in msg ? (msg as JsonRpcResponse).result : undefined);
            }
          }
        }
      } catch {
        // ignore malformed messages
      }
    }
  }

  proc.stderr?.on("data", () => {
    // language server stderr is typically debug output — ignore
  });

  function sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      const body = JSON.stringify(req);
      proc.stdin!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
  }

  // Initialize the server
  await sendRequest("initialize", {
    processId: process.pid,
    capabilities: {},
    ...(opts.initializationParams ?? {}),
  });
  await sendRequest("initialized", {});

  return {
    async definition(uri, line, character) {
      const result = (await sendRequest("textDocument/definition", {
        textDocument: { uri },
        position: { line, character },
      })) as LspLocation | LspLocation[] | undefined;
      if (!result) return [];
      return Array.isArray(result) ? result : [result];
    },

    async references(uri, line, character) {
      const result = (await sendRequest("textDocument/references", {
        textDocument: { uri },
        position: { line, character },
        context: { includeDeclaration: true },
      })) as LspReference[] | undefined;
      return result ?? [];
    },

    async rename(uri, line, character, newName) {
      const result = (await sendRequest("textDocument/rename", {
        textDocument: { uri },
        position: { line, character },
        newName,
      })) as Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } } }>> | undefined;
      return result ?? {};
    },

    async diagnostics(_uri: string) {
      // Diagnostics are typically pushed via notifications; some servers
      // support workspace/source too. Fallback: return empty (push-based).
      return [];
    },

    async hover(uri, line, character) {
      const result = (await sendRequest("textDocument/hover", {
        textDocument: { uri },
        position: { line, character },
      })) as { contents: { value: string } | string } | null;
      if (!result) return null;
      const contents = typeof result.contents === "string"
        ? result.contents
        : result.contents.value;
      return { contents };
    },
  };
}
