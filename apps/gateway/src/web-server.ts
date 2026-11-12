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
 * `--serve-remote` / auth for this port are NOT this module's business.
 */

import * as http from "node:http";
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

/** Upstream request headers: everything but `host` and hop-by-hop fields. */
function upstreamHeaders(req: http.IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (lower === "host" || HOP_BY_HOP.has(lower)) continue;
    if (value !== undefined) headers[lower] = value;
  }
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
        res.writeHead(
          upstreamRes.statusCode ?? 502,
          upstreamRes.statusMessage,
          downstreamHeaders(upstreamRes, gatewayOrigin, webOrigin),
        );
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

