/**
 * HTTP auth guard for every gateway route.
 *
 * Returns true to let the request through; false means the guard already
 * wrote the response (302 cookie exchange or the uniform 401/429). Must run
 * AFTER CORS preflight and BEFORE any route matching so an unauthenticated
 * caller cannot enumerate routes (401, never a route-dependent 404).
 *
 * Rate limiting (R29) is part of the guard, not a wrapper around it: only a
 * failed authentication counts, so the limiter can never refuse a valid
 * credential, and `/health` (a public path) is not an authentication attempt
 * at all.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthResult, BrowserAuth } from "./browser-auth.js";
import { resolveClientIp, resolveProtocol } from "../client-ip.js";
import type { AuthRateLimiter } from "./rate-limit.js";

/**
 * Fixed 401 body. Every rejection is byte-identical so a caller cannot
 * learn whether a route exists, whether a session exists, or why the
 * credential was refused. The 429 carries the SAME body — the status and
 * `Retry-After` say "slow down"; the body still says nothing.
 */
const UNAUTHORIZED_BODY = JSON.stringify({ error: "Unauthorized" });

export interface AuthGuardOptions {
  /** Pathnames that skip the guard. Only /health. */
  publicPaths: readonly string[];
  /** Counts failed attempts per client IP. Absent → no limiting. */
  rateLimiter?: AuthRateLimiter;
  /**
   * Read the client IP (and protocol) from forwarding headers. Only true when
   * the operator stated a proxy is in front of this process.
   * @default false
   */
  trustProxy?: boolean;
}

/** Observation hooks for callers that need the raw outcome. */
export interface AuthGuardHooks {
  /**
   * Called once per request that actually attempted authentication — i.e.
   * not for a public path — with the resolved client IP and whether the
   * credential was accepted. A query-token exchange counts as a success.
   */
  onResult?: (ip: string, ok: boolean) => void;
}

/**
 * Companion attributes a caller appends when it forwards the exchange's
 * `Set-Cookie` to a Response it builds itself. Only the request knows the
 * protocol it arrived on, so `Secure` is decided here and nowhere else.
 */
export function cookieAttributesFor(
  req: IncomingMessage,
  opts: Pick<AuthGuardOptions, "trustProxy">,
): string {
  // Appended as `; Secure`, i.e. a real attribute separator. A bare ` Secure`
  // would make the last real attribute (`Expires=Thu, 19 Nov 2026 … GMT
  // Secure`) unparseable, so browsers would drop the expiry AND the flag.
  return resolveProtocol(req, { trustProxy: opts.trustProxy === true }) === "https:" ? "; Secure" : "";
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

export function createAuthGuard(
  auth: BrowserAuth,
  opts: AuthGuardOptions,
  hooks: AuthGuardHooks = {},
): AuthGuard {
  const publicPaths = new Set(opts.publicPaths);
  const limiter = opts.rateLimiter;
  const addressOptions = { trustProxy: opts.trustProxy === true };

  return async function guard(req, res, corsHeaders = {}): Promise<boolean> {
    if (publicPaths.has(pathnameOf(req.url))) {
      return true;
    }

    const ip = resolveClientIp(req, addressOptions);

    // Read BEFORE `authorize`, and only turned into a 429 after a failure: a
    // cooling-down address must still be able to present a valid credential
    // (see the ordering note below).
    const verdict = limiter?.check(ip);
    const retryAfterMs = verdict !== undefined && !verdict.allowed ? verdict.retryAfterMs : 0;

    const result = await auth.authorize(req);

    if (result.ok) {
      limiter?.recordSuccess(ip);
      hooks.onResult?.(ip, true);
      return true;
    }

    // Valid launch token on the query string: exchange it for an HttpOnly
    // cookie and redirect to a clean URL so the token does not survive in
    // the address bar.
    if (result.redirectTo !== undefined && result.setCookie !== undefined) {
      limiter?.recordSuccess(ip);
      hooks.onResult?.(ip, true);
      res.writeHead(302, {
        Location: result.redirectTo,
        // `cookieHeaderFor` + this request's own protocol; `cookieAttributesFor`
        // returns a `; Secure` suffix so the flag joins the attribute list
        // rather than swallowing the preceding `Expires`.
        "Set-Cookie": `${result.setCookie}${cookieAttributesFor(req, addressOptions)}`,
        ...corsHeaders,
      });
      res.end();
      return false;
    }

    // Every other failure — missing, malformed, or invalid credentials —
    // answers with the same minimal 401. It carries CORS headers so a
    // cross-origin client reads the status rather than a network error;
    // the body stays byte-identical regardless of why it was refused.
    limiter?.recordFailure(ip);
    hooks.onResult?.(ip, false);

    // Over the limit: 429 with the wait, before the 401 would have gone out.
    // Same body as the 401 on purpose — the status says "slow down", and
    // nothing here says WHETHER a guess would have been right.
    //
    // The order matters in both directions. A valid credential was returned
    // above, so the cooldown can never lock out the operator; and a failure
    // is counted before the 429 is written, so the cooldown keeps extending
    // for as long as someone keeps guessing.
    if (retryAfterMs > 0) {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(UNAUTHORIZED_BODY),
        // Rounded up so a client that obeys the header exactly never comes
        // back a millisecond early.
        "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
        ...corsHeaders,
      });
      res.end(UNAUTHORIZED_BODY);
      return false;
    }

    res.writeHead(401, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(UNAUTHORIZED_BODY),
      ...corsHeaders,
    });
    res.end(UNAUTHORIZED_BODY);
    return false;
  };
}