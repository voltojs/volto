/**
 * `volto web` — the exported UI and a reverse proxy to a gateway, on one
 * origin.
 *
 * The gateway (`volto`, default :3100) owns the API, the session and the
 * access cookie. `volto web` puts the UI in front of it on a second port so a
 * tunnel can expose ONLY the UI: the browser talks to this origin, and every
 * API path is forwarded upstream with its method, headers and body intact.
 *
 * Two properties are load-bearing:
 *
 * - STREAMING. `/events` is server-sent events; a body that is read to
 *   completion before being written deadlocks every live turn (the stream
 *   never ends, so nothing is ever flushed). The response pipe is therefore
 *   `upstream.pipe(res)` with no buffering anywhere.
 * - Same-origin credentials. The auth guard runs at the gateway, but the
 *   browser's cookie jar is keyed by the origin it talks to — this one — so
 *   `Set-Cookie` is forwarded verbatim (no rewrite, no domain) and the next
 *   request's `Cookie` header rides back upstream unchanged.
 *
 * `/ws` is a real WebSocket endpoint on the gateway, and a WS handshake is
 * not an ordinary request: Node answers an unhandled `upgrade` with 400. The
 * server therefore also registers an `upgrade` listener that tunnels to the
 * gateway (see `tunnelUpgrade`).
 *
 * `--serve-remote` / auth for this port are NOT this module's business.
 */

import * as http from "node:http";
import type { Duplex } from "node:stream";
import { buildConfigScript, serveStatic } from "./static/serve.js";

/**
 * Root prefixes of the gateway's API routes — the list the gateway's own
 * static hosting steps aside for. `server.ts` imports it from here, so there
 * is exactly one list: a route added to the gateway is proxied by
 * `volto web` without a second edit, and `__tests__/web-server.test.ts` proves
 * each root (and a sub-path of it) reaches the gateway rather than the static
 * reader.
 */
export const API_PREFIXES = [
  "/health",
  "/events",
  "/messages",
  "/interrupt",
  "/approvals",
  "/run",
  "/resume",
  "/stream",
  "/ws",
  "/projects",
  "/catalog",
  "/preferences",
  "/config",
  "/sidebar-state",
  "/providers",
  "/commands",
  "/skills",
  "/tools",
  "/agents",
  "/sessions",
  "/fs",
  "/file-refs",
  "/git",
  "/attachments",
] as const;

export interface WebServerOptions {
  /** 0 lets the OS pick; read the real port from `server.address()`. */
  port: number;
  host?: string;
  /** Upstream base URL, e.g. `http://127.0.0.1:3100`. */
  gateway: string;
  /** Exported web build (`apps/web/out`, or the packaged `web/`). */
  webRoot: string;
  /** Override the version published in `volto-config.js` (tests). */
  version?: string;
}

/** `true` when `pathname` is `prefix` itself or sits below it. */
export function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"));
}

/** The request's own path, exactly as sent — no URL-parser repair. */
function rawPathname(rawUrl: string | undefined): string {
  const target = rawUrl ?? "/";
  const queryStart = target.indexOf("?");
  return queryStart < 0 ? target : target.slice(0, queryStart);
}

/** Hop-by-hop headers must not be forwarded (RFC 7230 §6.1). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Upstream request headers: drop hop-by-hop fields only.
 *
 * The client's `Host` rides along BECAUSE the gateway decides same-origin by
 * comparing it with `Origin` (`new URL(origin).host === host`); rewriting it
 * to the gateway's own address would make every browser request from the web
 * origin 403.
 */
function upstreamHeaders(req: http.IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (value !== undefined) headers[name.toLowerCase()] = value;
  }
  return headers;
}

/**
 * Upstream headers for a WebSocket handshake.
 *
 * A handshake is the one place the hop-by-hop fields are the POINT: `ws` (and
 * Node's own HTTP parser) only emit an `upgrade` event when the arriving
 * request carries an `Upgrade` token in `Connection`. Dropping `Connection`
 * like `upstreamHeaders` does for a plain request would make the gateway see
 * an ordinary `GET /ws` — answered 404, never upgraded. So `Connection:
 * Upgrade` is rebuilt here alongside `Upgrade`, and every other hop-by-hop
 * field stays dropped.
 *
 * The client's own `Host` rides along for the same reason as on a plain
 * request: the gateway decides same-origin by comparing `Origin` with `Host`,
 * and rewriting it to the gateway's address would refuse (403) a browser on
 * the web origin.
 */
function upstreamUpgradeHeaders(req: http.IncomingMessage): http.OutgoingHttpHeaders {
  const headers = upstreamHeaders(req);
  headers["connection"] = "Upgrade";
  const upgrade = req.headers.upgrade;
  if (typeof upgrade === "string") headers["upgrade"] = upgrade;
  return headers;
}

/**
 * Upstream response headers, with `Set-Cookie` kept verbatim (array form, so
 * a rotated cookie is not collapsed to one) and `location` rewritten when it
 * points at the gateway's own origin — otherwise a 302 from the gateway would
 * send the browser to a host the tunnel does not expose.
 */
function downstreamHeaders(
  res: http.IncomingMessage,
  gatewayOrigin: string,
  webOrigin: string,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(res.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || value === undefined) continue;
    headers[lower] = value;
  }
  const location = headers["location"];
  if (typeof location === "string" && location.startsWith(gatewayOrigin)) {
    headers["location"] = webOrigin + location.slice(gatewayOrigin.length);
  }
  return headers;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/** Answer an upgrade that will not be tunnelled, then close the socket. */
function reportNoTunnel(socket: Duplex, status: number, reason: string): void {
  // `end`, not `destroy`: a response written and immediately destroyed is
  // lost to the peer often enough to matter (RST before it reads).
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Start the web server. Resolves once it is listening, so a caller can read
 * the bound port (and fail fast on `EADDRINUSE`) before returning to the
 * caller's own loop.
 */
export async function startWebServer(opts: WebServerOptions): Promise<http.Server> {
  const gatewayBase = new URL(opts.gateway);
  const gatewayOrigin = gatewayBase.origin;
  const configScript = buildConfigScript({ gatewayUrl: "", version: opts.version ?? "0.0.0" });
  const webRoot = opts.webRoot;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.warn("web:", err instanceof Error ? err.message : err);
      writeJson(res, 500, { error: "Internal error" });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const pathname = rawPathname(req.url);
    if (isApiPath(pathname)) {
      proxy(req, res);
      return;
    }

    // Everything else is the exported app, through the gateway's own reader —
    // never a second static server: the traversal and symlink boundary lives
    // in exactly one place.
    const handled = await serveStatic(req, res, pathname, {
      webRoot,
      apiRoots: API_PREFIXES,
      configScript,
    });
    if (handled) return;
    writeJson(res, 404, { error: "Not found" });
  }

  /**
   * A WebSocket handshake. Node answers an `upgrade` with 400 unless a
   * listener takes it, so `/ws` would be unreachable behind this server
   * without this. Path matching mirrors `handle`: the same `API_PREFIXES`.
   */
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = rawPathname(req.url);
    if (!isApiPath(pathname)) {
      reportNoTunnel(socket, 404, "Not Found");
      return;
    }
    tunnelUpgrade(req, socket, head);
  });

  /**
   * Tunnel one upgrade to the gateway.
   *
   * A handshake is not a request/response pair: the upstream answer arrives
   * as an `upgrade` event on the CLIENT request object, with any bytes the
   * gateway sent past the 101 already split into `upstreamHead`. Those go to
   * the browser first (they are part of the stream), then the two sockets are
   * spliced together — bidirectional, unpumped by us, so a long-lived socket
   * costs nothing per message.
   *
   * Headers are a plain request's, plus the `Connection: Upgrade` token the
   * gateway needs to treat this as a handshake (see `upstreamUpgradeHeaders`).
   * The 101 is answered on this socket, so the browser's own client library
   * sees exactly the handshake it expects — just from a different peer.
   *
   * Any failure BEFORE the backend socket exists (the gateway is down, the
   * request was malformed) answers on the client socket, because there is no
   * other way to tell the browser what happened; once the tunnel is up, the
   * two sockets are simply closed together.
   */
  function tunnelUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const target = new URL(req.url ?? "/", gatewayBase);
    if (gatewayBase.protocol !== "http:") {
      reportNoTunnel(socket, 502, "Gateway unreachable");
      return;
    }

    const upstream = http.request({
      hostname: gatewayBase.hostname,
      port: gatewayBase.port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: upstreamUpgradeHeaders(req),
      // The gateway's answer is written back per-request (it is computed
      // from the upstream's own handshake), so no agent-level pooling.
      agent: false,
    });

    upstream.on("upgrade", (upstreamRes: http.IncomingMessage, backendSocket: Duplex, upstreamHead: Buffer) => {
      // Re-emit the gateway's 101 (status line + raw headers) as this
      // connection's handshake answer, then splice the sockets: anything the
      // gateway already sent past its 101 goes to the browser first, anything
      // the browser sent past its request goes to the gateway.
      const statusLine = `HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? "Switching Protocols"}\r\n`;
      const raw = upstreamRes.rawHeaders ?? [];
      const headerLines: string[] = [];
      for (let i = 0; i < raw.length; i += 2) headerLines.push(`${raw[i]}: ${raw[i + 1]}\r\n`);
      socket.write(statusLine + headerLines.join("") + "\r\n");
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) backendSocket.write(head);
      socket.pipe(backendSocket);
      backendSocket.pipe(socket);
      // Not half-open: when either party leaves, the other half goes with it.
      socket.on("close", () => backendSocket.destroy());
      backendSocket.on("close", () => socket.destroy());
    });

    upstream.on("response", (upstreamRes: http.IncomingMessage) => {
      // The gateway answered with a real HTTP status instead of upgrading
      // (401 / 403 / 404 from its own guard): pass that back so the browser
      // sees an honest code, not a hung socket.
      const lines = [`HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? ""}\r\n`];
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) {
          lines.push(`${name}: ${item}\r\n`);
        }
      }
      lines.push("\r\n");
      socket.write(lines.join(""));
      upstreamRes.resume();
      upstreamRes.on("end", () => socket.destroy());
    });

    upstream.on("error", () => reportNoTunnel(socket, 502, "Gateway unreachable"));
    socket.on("error", () => upstream.destroy());
    upstream.end();
  }

  /** Forward one request upstream and stream its answer straight back. */
  function proxy(req: http.IncomingMessage, res: http.ServerResponse): void {
    const target = new URL(req.url ?? "/", gatewayBase);
    // Keep the client's own host so the gateway's Origin/Host check compares
    // the same values a browser sent; the socket goes to the gateway either way.
    const headers = upstreamHeaders(req);
    if (typeof req.headers.host === "string") headers["host"] = req.headers.host;

    const upstream = http.request(
      {
        protocol: gatewayBase.protocol,
        hostname: gatewayBase.hostname,
        port: gatewayBase.port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (upstreamRes) => {
        const webOrigin = `http://${req.headers.host ?? "localhost"}`;
        const headers = downstreamHeaders(upstreamRes, gatewayOrigin, webOrigin);
        // Headers go out exactly as the upstream wrote them. `Content-Length`
        // counts the bytes on the wire, which is what is piped here unchanged:
        // a compressed body keeps its compressed length and its encoding, and
        // the hop re-frames on its own (chunked) only when the upstream itself
        // sent neither. Nothing is decoded, so nothing can be truncated.
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, headers);
        // The stream, not the body: `pipe` writes each chunk as it arrives.
        upstreamRes.pipe(res);
        upstreamRes.on("error", () => res.destroy());
      },
    );

    upstream.on("error", () => {
      writeJson(res, 502, { error: "Gateway unreachable" });
    });
    // A client that hangs up must not leave the upstream request (or an SSE
    // connection it opened) dangling.
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: opts.port, ...(opts.host !== undefined ? { host: opts.host } : {}) }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

