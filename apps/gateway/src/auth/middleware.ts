/**
 * HTTP auth guard for every gateway route.
 *
 * Returns true to let the request through; false means the guard already
 * wrote the response (302 cookie exchange or the uniform 401). Must run
 * AFTER CORS preflight and BEFORE any route matching so an unauthenticated
 * caller cannot enumerate routes (401, never a route-dependent 404).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthResult, BrowserAuth } from "./browser-auth.js";

/**
 * Fixed 401 body. Every rejection is byte-identical so a caller cannot
 * learn whether a route exists, whether a session exists, or why the
 * credential was refused.
 */
const UNAUTHORIZED_BODY = JSON.stringify({ error: "Unauthorized" });

export interface AuthGuardOptions {
  /** Pathnames that skip the guard. Only /health. */
  publicPaths: readonly string[];
}

/**
 * Resolves true when the request may proceed; false when the guard has
 * already written the response. Asynchronous because `authorize` resolves the
 * live token generation per request (a rotation must be honoured without a
 * restart).
 *
 * `corsHeaders` must be the same headers the route handlers use. Without
 * them a cross-origin caller sees a CORS network error instead of the 401
 * and cannot tell "not authenticated" apart from "gateway is down".
 */
export type AuthGuard = (
  req: IncomingMessage,
  res: ServerResponse,
  corsHeaders?: Record<string, string>,
) => Promise<boolean>;

function pathnameOf(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

/**
 * A valid query-token exchange (ok:false + redirectTo/setCookie) counts as
 * authorized for WebSocket upgrades: the token was valid, but a WS
 * handshake cannot complete a 302 + Set-Cookie exchange the way a browser
 * navigation can.
 */
export function isAuthorized(result: AuthResult): boolean {
  if (result.ok) return true;
  return result.redirectTo !== undefined && result.setCookie !== undefined;
}

export function createAuthGuard(auth: BrowserAuth, opts: AuthGuardOptions): AuthGuard {
  const publicPaths = new Set(opts.publicPaths);

  return async function guard(req, res, corsHeaders = {}): Promise<boolean> {
    if (publicPaths.has(pathnameOf(req.url))) {
      return true;
    }

    const result = await auth.authorize(req);

    if (result.ok) {
      return true;
    }

    // Valid launch token on the query string: exchange it for an HttpOnly
    // cookie and redirect to a clean URL so the token does not survive in
    // the address bar.
    if (result.redirectTo !== undefined && result.setCookie !== undefined) {
      res.writeHead(302, {
        Location: result.redirectTo,
        "Set-Cookie": result.setCookie,
        ...corsHeaders,
      });
      res.end();
      return false;
    }

    // Every other failure — missing, malformed, or invalid credentials —
    // answers with the same minimal 401. It carries CORS headers so a
    // cross-origin client reads the status rather than a network error;
    // the body stays byte-identical regardless of why it was refused.
    res.writeHead(401, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(UNAUTHORIZED_BODY),
      ...corsHeaders,
    });
    res.end(UNAUTHORIZED_BODY);
    return false;
  };
}
