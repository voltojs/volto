/**
 * HTTP auth guard for every gateway route.
 *
 * Returns true to let the request through; false means the guard already
 * wrote the response (302 cookie exchange or the uniform 401/429). Must run
 * AFTER CORS preflight and BEFORE any route matching so an unauthenticated
 * caller cannot enumerate routes (401, never a route-dependent 404).
 *
 * `?token=` has exactly two jobs, both of them GET/HEAD only: exchange the
 * credential for the cookie (302 to the clean URL), or strip an already-held
 * credential's parameter from the address bar (also 302). A non-GET request
 * carrying `?token=` is never rewritten -- a redirect would drop its body --
 * so it goes through the ordinary path and is allowed or answered 401.
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

/** The query parameter a login URL carries. */
const TOKEN_PARAM = "token";

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
 * Companion attributes for a session cookie, computed from the request that
 * earned it: only the request knows the protocol it arrived on, so `Secure`
 * follows the request that actually authenticated, not the listener's
 * configuration.
 *
 * The guard uses this for the `Set-Cookie` it writes. A reverse proxy that
 * forwards a gateway `Set-Cookie` (as `volto web` does) ships that header
 * verbatim — this function is not in the proxy's path, and cannot be: the
 * gateway already decided the flag from the request it saw. That is why
 * `--trust-proxy` matters behind a TLS-terminating tunnel; without it the
 * gateway sees plain HTTP and the cookie carries no `Secure`.
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

/**
 * Resolve a redirect target for a request that should end up on the SAME page
 * without its `token` query parameter, or `undefined` when there is nothing to
 * remove (`/`, `/?a=1`).
 *
 * Hand-written rather than `new URL(...)` + `URLSearchParams`: this target is
 * handed back to the browser as a `Location` ON THIS ORIGIN, and the URL parser
 * would normalize it as a URL, not as a path -- `//host?token=x` would become
 * a protocol-relative redirect to another host. Here only the `token` pairs
 * are dropped: the kept ones are re-emitted byte-for-byte, in order (so
 * `/?next=%2Fb&token=x` redirects to `/?next=%2Fb`, not to a re-encoded
 * `?next=%2Fb`), and a name is compared after decoding (`to%6Ben` and `TOKEN`
 * both name `token`; an uppercase spelling would otherwise survive the very
 * cleanup it was aimed at).
 *
 * @param rawUrl the request target as received (`req.url`)
 * @returns the path-and-query to redirect to, without `token`
 */
export function tokenFreeTarget(rawUrl: string | undefined): string | undefined {
  const target = rawUrl ?? "/";
  const queryStart = target.indexOf("?");
  if (queryStart < 0) return undefined;
  const path = target.slice(0, queryStart);
  const kept: string[] = [];
  let removed = false;
  for (const pair of target.slice(queryStart + 1).split("&")) {
    if (pair === "") continue;
    if (isTokenPair(pair)) {
      removed = true;
      continue;
    }
    kept.push(pair);
  }
  if (!removed) return undefined;
  return kept.length === 0 ? path : `${path}?${kept.join("&")}`;
}

/** Whether one raw `name=value` query pair names the `token` parameter. */
function isTokenPair(pair: string): boolean {
  const eq = pair.indexOf("=");
  const encodedName = eq < 0 ? pair : pair.slice(0, eq);
  try {
    return decodeURIComponent(encodedName.replace(/\+/g, " ")).toLowerCase() === TOKEN_PARAM;
  } catch {
    // A malformed escape cannot name the token: the parameter is ASCII.
    return false;
  }
}

/**
 * Whether the guard may answer this request with a 302 instead of letting it
 * through: only a browser document navigation (GET/HEAD) can be redirected
 * without losing what it was carrying, and only a navigation keeps its URL in
 * history, the referrer and the tunnel's request log.
 *
 * `Sec-Fetch-Mode` decides. A browser is the only client that sends it, and
 * `navigate` is its one value for a document load; `cors` / `same-origin` /
 * `no-cors` are what a page's own `fetch()` sends, and such a call keeps its
 * API semantics -- holding a valid token in its URL is its own choice, and a
 * bounce would hide the answer it asked for. A client that sends no
 * `Sec-Fetch-Mode` at all (curl, a script, HTTP/1.0) is not navigated by a
 * redirect, so it is not redirected either.
 */
function redirectable(req: IncomingMessage): boolean {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") return false;
  const fetchMode = req.headers["sec-fetch-mode"];
  return (Array.isArray(fetchMode) ? fetchMode[0] : fetchMode) === "navigate";
}

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
 * navigation can -- the guard leaves that redirect to the 101 path for GET.
 * The guard itself only writes the exchange for GET/HEAD document
 * navigations, so a token-bearing POST is never answered with a redirect.
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
      // A credential the caller already holds (cookie or bearer) plus a
      // `?token=` in the URL: the token is not needed for this request, but
      // the URL still carries it into the browser's history, its referrer
      // and the tunnel's request log. Redirect once to the same page without
      // the parameter. Nothing is exchanged -- the session cookie already is
      // what authorizes the request that follows -- and any other query
      // parameter is preserved.
      const cleanTarget = redirectable(req) ? tokenFreeTarget(req.url) : undefined;
      if (cleanTarget !== undefined) {
        res.writeHead(302, {
          // `no-store`: the response points at the credential-free URL, so a
          // cache must not serve this redirect for a later request.
          "Cache-Control": "no-store",
          Location: cleanTarget,
          ...corsHeaders,
        });
        res.end();
        return false;
      }
      return true;
    }

    // A valid token on the query string of a document navigation:
    // exchange it for an HttpOnly cookie and redirect to the clean URL, so
    // the credential does not survive in the address bar, the history, the
    // referrer or the tunnel's log.
    //
    // Only a browser document navigation is redirected. A redirect re-issues
    // the request as GET without its body, so a `POST /messages?token=…` must
    // reach the route intact; a browser traffic-mode fetch keeps its own API
    // call semantics instead of being bounced. Either way a refused credential
    // keeps the uniform 401 -- only the redirect is withheld, never the check.
    if (
      result.redirectTo !== undefined &&
      result.setCookie !== undefined &&
      redirectable(req)
    ) {
      limiter?.recordSuccess(ip);
      hooks.onResult?.(ip, true);
      res.writeHead(302, {
        // The clean URL for THIS request, not a hardcoded root: a login link
        // to a deep path lands on that path.
        Location: tokenFreeTarget(req.url) ?? result.redirectTo,
        // `no-store`: this is the answer that hands out a session; another
        // browser or a proxy must never replay it.
        "Cache-Control": "no-store",
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