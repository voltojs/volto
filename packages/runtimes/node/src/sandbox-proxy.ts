/**
 * Local HTTP/SOCKS proxy for sandbox egress filtering (Plan 009 Phase 4).
 *
 * Runs outside the sandbox in the parent process. The sandboxed child
 * connects to this proxy via unix domain socket + socat (Linux) or
 * direct loopback (macOS). The proxy validates CONNECT target hosts
 * against an allowlist; non-matching hosts get 403.
 *
 * Lifecycle: start() → listen on unix socket → stop() cleans up.
 */

import { createServer, createConnection as netCreateConnection, type Server, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface SandboxProxyConfig {
  /** Allowed hostnames. Non-matching CONNECT requests get 403. */
  allowedHosts: string[];
}

export interface SandboxProxy {
  /** Unix socket path the proxy listens on */
  socketPath: string;
  /** TCP port socat bridges to the unix socket (Linux only) */
  tcpPort: number;
  /** Start listening. Resolves when the server is ready. */
  start(): Promise<void>;
  /** Stop the proxy and clean up the socket file. */
  stop(): Promise<void>;
}

/** Unique socket path counter (monotonic, survives same-millisecond calls) */
let proxyCounter = 0;

/** Generate a unique socket path for this proxy instance */
function makeSocketPath(): string {
  const id = `${process.pid}-${++proxyCounter}`;
  return join(tmpdir(), `agent-core-proxy-${id}.sock`);
}

/**
 * Check if a hostname is in the allowlist.
 * Supports exact match and wildcard suffix (e.g. "*.example.com").
 */
export function isHostAllowed(host: string, allowedHosts: string[]): boolean {
  for (const pattern of allowedHosts) {
    if (pattern === host) return true;
    // Wildcard: *.example.com matches foo.example.com but not example.com
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      if (host.endsWith(suffix)) return true;
    }
  }
  return false;
}

/**
 * Handle a CONNECT request: validate host against allowlist,
 * then tunnel bidirectionally.
 */
function handleConnect(
  targetHost: string,
  targetPort: number,
  clientSocket: Socket,
  allowedHosts: string[],
): void {
  if (!isHostAllowed(targetHost, allowedHosts)) {
    clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  const target = createServer();
  target.once("error", () => {
    clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    clientSocket.destroy();
  });

  target.listen(0, "127.0.0.1", () => {
    const addr = target.address();
    if (!addr || typeof addr === "string") {
      clientSocket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      clientSocket.destroy();
      target.close();
      return;
    }

    const upstream = createServer();
    upstream.once("connection", (upstreamSocket) => {
      target.close(); // stop accepting
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
      upstreamSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstreamSocket.destroy());
    });

    upstream.listen(0, "127.0.0.1", () => {
      const upAddr = upstream.address();
      if (!upAddr || typeof upAddr === "string") {
        clientSocket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        clientSocket.destroy();
        target.close();
        upstream.close();
        return;
      }
      // Connect to the real target
      const realTarget = netCreateConnection({ host: targetHost, port: targetPort }, () => {
        upstream.close(); // stop accepting — we have our pipe
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        clientSocket.pipe(realTarget);
        realTarget.pipe(clientSocket);
        realTarget.on("error", () => clientSocket.destroy());
        clientSocket.on("error", () => realTarget.destroy());
      });
      realTarget.on("error", () => {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.destroy();
        upstream.close();
        target.close();
      });
    });
  });
}

/**
 * Create a local HTTP proxy that validates CONNECT requests against an allowlist.
 */
export function createSandboxProxy(config: SandboxProxyConfig): SandboxProxy {
  const socketPath = makeSocketPath();
  let server: Server | null = null;
  const tcpPort = 0; // Will be assigned by socat or dynamically

  return {
    socketPath,
    tcpPort,

    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server = createServer((socket) => {
          let requestLine = "";
          socket.once("data", (chunk) => {
            const data = chunk.toString();
            const lines = data.split("\r\n");
            requestLine = lines[0] ?? "";

            const parts = requestLine.split(" ");
            const method = parts[0];
            const target = parts[1]; // e.g. "host:port" for CONNECT

            if (method === "CONNECT" && target) {
              const colonIdx = target.lastIndexOf(":");
              const host = colonIdx > 0 ? target.slice(0, colonIdx) : target;
              const port = colonIdx > 0 ? parseInt(target.slice(colonIdx + 1), 10) : 443;
              handleConnect(host, port, socket, config.allowedHosts);
            } else {
              // Non-CONNECT: reject (we only tunnel)
              socket.write("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
              socket.destroy();
            }
          });
        });

        server.on("error", reject);
        server.listen(socketPath, () => {
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
        server = null;
      }
      try { unlinkSync(socketPath); } catch { /* best-effort */ }
    },
  };
}
