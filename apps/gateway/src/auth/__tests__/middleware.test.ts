import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createBrowserAuth, type BrowserAuth } from "../browser-auth.js";
import { createAuthGuard, isAuthorized, cookieAttributesFor, tokenFreeTarget } from "../middleware.js";
import { createAuthRateLimiter } from "../rate-limit.js";

let dir: string;
let auth: BrowserAuth;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "volto-guard-"));
  auth = await createBrowserAuth({ dir });
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

function reqWith(headers: Record<string, string>, url = "/"): IncomingMessage {
  return { url, headers } as unknown as IncomingMessage;
}

interface CapturedResponse {
  status?: number;
  headers?: Record<string, string | number>;
  body?: string;
}

function mockRes(): { res: ServerResponse; state: CapturedResponse } {
  const state: CapturedResponse = {};
  const res = {
    writeHead(status: number, headers?: Record<string, string | number>) {
      state.status = status;
      state.headers = headers;
      return res;
    },
    end(chunk?: string) {
      if (chunk !== undefined) state.body = chunk;
      return res;
    },
  } as unknown as ServerResponse;
  return { res, state };
}

describe("createAuthGuard", () => {
  const publicPaths = ["/health"] as const;

  it("allows a public path with no credentials", async () => {
    const guard = createAuthGuard(auth, { publicPaths });
    const { res, state } = mockRes();
    expect(await guard(reqWith({}, "/health"), res)).toBe(true);
    expect(state.status).toBeUndefined();
  });

  it("allows an authenticated bearer request", async () => {
    const guard = createAuthGuard(auth, { publicPaths });
    const { res, state } = mockRes();
    expect(
      await guard(reqWith({ authorization: `Bearer ${auth.launchToken}` }, "/projects"), res),
    ).toBe(true);
    expect(state.status).toBeUndefined();
  });

  it("rejects an unauthenticated request with the uniform 401 body", async () => {
    const guard = createAuthGuard(auth, { publicPaths });
    const { res, state } = mockRes();
    expect(await guard(reqWith({}, "/providers"), res)).toBe(false);
    expect(state.status).toBe(401);
    expect(state.body).toBe(JSON.stringify({ error: "Unauthorized" }));
  });

  it("answers an unknown route with the same 401 body as a known one", async () => {
    const guard = createAuthGuard(auth, { publicPaths });
    const known = mockRes();
    const unknown = mockRes();
    await guard(reqWith({}, "/providers"), known.res);
    await guard(reqWith({}, "/nonexistent-route"), unknown.res);
    expect(known.state.status).toBe(unknown.state.status);
    expect(known.state.body).toBe(unknown.state.body);
  });

  it("exchanges a valid query token for a cookie and a clean redirect", async () => {
    const guard = createAuthGuard(auth, { publicPaths });
    const { res, state } = mockRes();
    // A navigation is what a login link is; see the GET/HEAD-only cases below
    // for what a programmatic call and a POST get instead.
    expect(await guard(reqWith({ "sec-fetch-mode": "navigate" }, `/?token=${auth.launchToken}`), res)).toBe(false);
    expect(state.status).toBe(302);
    expect(state.headers?.["Location"]).toBe("/");
    expect(String(state.headers?.["Set-Cookie"])).toContain("volto_auth=");
  });

  it("rejects an invalid bearer token with the same 401 as a missing one", async () => {
    const guard = createAuthGuard(auth, { publicPaths });
    const missing = mockRes();
    const invalid = mockRes();
    await guard(reqWith({}, "/projects"), missing.res);
    await guard(reqWith({ authorization: "Bearer not-the-token" }, "/projects"), invalid.res);
    expect(missing.state.status).toBe(invalid.state.status);
    expect(missing.state.body).toBe(invalid.state.body);
  });
});

describe("query token never survives the address bar (GET/HEAD only)", () => {
  const publicPaths = ["/health"] as const;
  /** Bind the recording double's accessors to plain locals. */
  function destructure(recorded: ReturnType<typeof recordingRes>): {
    res: ServerResponse;
    status: () => number | undefined;
    headers: () => Record<string, unknown>;
  } {
    return { res: recorded.res, status: recorded.status, headers: recorded.headers };
  }

  /** A browser document navigation, as Chrome/Safari send it. */
  const navigate = (extra: Record<string, string> = {}): Record<string, string> => ({
    "sec-fetch-mode": "navigate",
    accept: "text/html,application/xhtml+xml",
    ...extra,
  });

  /**
   * A response double that records what was written. `headers` is a getter,
   * not a snapshot: reading it before the guard ran must not freeze an empty
   * object into the assertion that follows.
   */
  function recordingRes(): {
    res: ServerResponse;
    status: () => number | undefined;
    headers: () => Record<string, unknown>;
  } {
    const state: { status?: number; headers: Record<string, unknown> } = { headers: {} };
    const res = {
      writeHead(status: number, headers?: Record<string, unknown>) {
        state.status = status;
        state.headers = headers ?? {};
        return res;
      },
      end() {
        return res;
      },
    } as unknown as ServerResponse;
    return { res, status: () => state.status, headers: () => state.headers };
  }

  /**
   * Mint a real session cookie through the guard, then return it as a
   * `Cookie:` header value (`volto_auth=…`). A navigation's redirect carries
   * the cookie already -- nothing is kept in the browser by this suite.
   */
  async function sessionCookie(): Promise<string> {
    const guard = createAuthGuard(auth, { publicPaths });
    const exchange = recordingRes();
    await guard(reqWith(navigate({}), `/?token=${auth.launchToken}`), exchange.res);
    const header = String(exchange.headers()["Set-Cookie"]);
    expect(exchange.status()).toBe(302);
    return header.split(";")[0]!;
  }

  it("tokenFreeTarget rewrites only the token parameter, keeping the rest verbatim", () => {
    expect(tokenFreeTarget("/?token=x")).toBe("/");
    expect(tokenFreeTarget("/?token=x&")).toBe("/");
    expect(tokenFreeTarget("/sessions/abc?token=x")).toBe("/sessions/abc");
    expect(tokenFreeTarget("/?a=1&token=x&a=2")).toBe("/?a=1&a=2");
    expect(tokenFreeTarget("/?next=%2Fsessions%2F1&token=x")).toBe("/?next=%2Fsessions%2F1");
    // Nothing to remove -> no redirect.
    expect(tokenFreeTarget("/?a=1")).toBeUndefined();
    expect(tokenFreeTarget("/")).toBeUndefined();
  });

  it("an already authenticated navigation carrying ?token= is redirected once to the clean URL", async () => {
    const guard = createAuthGuard(auth, { publicPaths });
    const cookie = await sessionCookie();
    const { res, status, headers } = destructure(recordingRes());
    // Not a token exchange: the cookie is the credential, the URL is just dirty.
    expect(await guard(reqWith(navigate({ cookie }), "/?token=stale-in-the-url"), res)).toBe(false);
    expect(status()).toBe(302);
    expect(headers()["Location"]).toBe("/");
    // Nothing is minted: this redirect only cleans the URL.
    expect(headers()["Set-Cookie"]).toBeUndefined();
    expect(headers()["Cache-Control"]).toBe("no-store");
  });

  it("the exchange redirects to this request's own clean URL, not to a hardcoded root", async () => {
    const guard = createAuthGuard(auth, { publicPaths });
    const { res, status, headers } = destructure(recordingRes());
    expect(
      await guard(reqWith(navigate({}), `/sessions/abc?page=2&token=${auth.launchToken}`), res),
    ).toBe(false);
    expect(status()).toBe(302);
    expect(headers()["Location"]).toBe("/sessions/abc?page=2");
    expect(String(headers()["Set-Cookie"])).toContain("volto_auth=");
  });

  it("an unauthenticated navigation with a bad token still gets the uniform 401", async () => {
    const guard = createAuthGuard(auth, { publicPaths });
    const { res, status, headers } = destructure(recordingRes());
    expect(await guard(reqWith(navigate({}), "/?token=not-the-token"), res)).toBe(false);
    expect(status()).toBe(401);
    expect(headers()["Location"]).toBeUndefined();
  });

  it("a programmatic fetch is not redirected: the credential it holds decides", async () => {
    // `Sec-Fetch-Mode: cors` is not a navigation, so the guard never answers
    // it with a 302 -- an API client that follows redirects or not must get
    // the answer it asked for, not a bounce.
    const guard = createAuthGuard(auth, { publicPaths });
    const api = (mode: string): ReturnType<typeof recordingRes> & { mode: string } => ({
      ...recordingRes(),
      mode,
    });

    // With the cookie, the request goes through untouched (token and all).
    // The URL's own token must not stand in for it: see the middle case.
    const cookie = await sessionCookie();
    const authorized = api("cors");
    expect(
      await guard(reqWith({ cookie, "sec-fetch-mode": authorized.mode, accept: "application/json" }, `/projects?token=stale`), authorized.res),
    ).toBe(true);
    expect(authorized.status()).toBeUndefined();

    // Without it, not even a VALID token in the URL is exchanged into a
    // cookie here: the answer is the uniform 401 that a POST (which cannot be
    // redirected at all) would receive, never a redirect.
    const unauthorized = api("cors");
    expect(
      await guard(
        reqWith({ "sec-fetch-mode": unauthorized.mode, accept: "application/json" }, `/projects?token=${auth.launchToken}`),
        unauthorized.res,
      ),
    ).toBe(false);
    expect(unauthorized.status()).toBe(401);
    expect(unauthorized.headers()["Set-Cookie"]).toBeUndefined();
  });

  it("a POST carrying ?token= is neither redirected nor answered with a cookie", async () => {
    // A 302 re-issues the request as GET without its body, so the exchange
    // (and the address-bar cleanup) must never apply here. 401 stays 401.
    const guard = createAuthGuard(auth, { publicPaths });
    const bad = recordingRes();
    expect(
      await guard(
        { method: "POST", url: `/?token=not-the-token`, headers: navigate({ "content-type": "application/json" }) } as unknown as IncomingMessage,
        bad.res,
      ),
    ).toBe(false);
    expect(bad.status()).toBe(401);
    expect(bad.headers()["Location"]).toBeUndefined();

    // Even a VALID token on a POST is not exchanged: the request goes through
    // untouched, and it is the caller's own credential that decides it.
    const valid = recordingRes();
    expect(
      await guard(
        { method: "POST", url: `/messages?token=${auth.launchToken}`, headers: navigate({}) } as unknown as IncomingMessage,
        valid.res,
      ),
    ).toBe(false);
    expect(valid.status()).toBe(401);
    expect(valid.headers()["Set-Cookie"]).toBeUndefined();

    // A valid token on a POST is not a credential at all, so it does not
    // change what a held session cookie already decides.
    const cookie = await sessionCookie();
    const clean = recordingRes();
    expect(
      await guard(
        { method: "POST", url: `/messages`, headers: { cookie } } as unknown as IncomingMessage,
        clean.res,
      ),
    ).toBe(true);
    expect(clean.status()).toBeUndefined();
  });

  it("an authenticated HEAD navigation is cleaned too", async () => {
    const guard = createAuthGuard(auth, { publicPaths });
    const cookie = await sessionCookie();
    const { res, status, headers } = destructure(recordingRes());
    expect(
      await guard(
        { method: "HEAD", url: "/?token=x", headers: navigate({ cookie }) } as unknown as IncomingMessage,
        res,
      ),
    ).toBe(false);
    expect(status()).toBe(302);
    expect(headers()["Location"]).toBe("/");
  });

  it("cookieAttributesFor is still the only place Secure is decided for this guard", () => {
    expect(cookieAttributesFor(reqWith({}), {})).toBe("");
  });
});

describe("isAuthorized", () => {
  it("treats a valid cookie/bearer as authorized", () => {
    expect(isAuthorized({ ok: true })).toBe(true);
  });

  it("treats a valid query-token exchange as authorized (WS cannot redirect)", () => {
    expect(
      isAuthorized({ ok: false, setCookie: "volto_auth=x", redirectTo: "/" }),
    ).toBe(true);
  });

  it("treats a plain failure as unauthorized", () => {
    expect(isAuthorized({ ok: false })).toBe(false);
  });
});

describe("createAuthGuard with a rate limiter (R29)", () => {
  const publicPaths = ["/health"] as const;

  function reqAt(headers: Record<string, string>, remoteAddress = "127.0.0.1", url = "/projects"): IncomingMessage {
    return { url, headers, socket: { remoteAddress } } as unknown as IncomingMessage;
  }

  it("records a failed attempt against the client IP and answers 429 before the 401", async () => {
    const t = 0;
    const limiter = createAuthRateLimiter({ limit: 2, now: () => t });
    const guard = createAuthGuard(auth, { publicPaths, rateLimiter: limiter });

    // First failure is an ordinary 401, with the counter now at 1.
    const first = mockRes();
    expect(await guard(reqAt({}), first.res)).toBe(false);
    expect(first.state.status).toBe(401);

    const second = mockRes();
    expect(await guard(reqAt({}), second.res)).toBe(false);
    expect(second.state.status).toBe(401);

    const blocked = mockRes();
    expect(await guard(reqAt({}), blocked.res)).toBe(false);
    expect(blocked.state.status).toBe(429);
    expect(Number(blocked.state.headers?.["Retry-After"])).toBeGreaterThan(0);
    // Byte-identical to the 401: the body never says "rate limited".
    expect(blocked.state.body).toBe(JSON.stringify({ error: "Unauthorized" }));
    expect(limiter.check("127.0.0.1").allowed).toBe(false);
  });

  it("a success clears the counter", async () => {
    const limiter = createAuthRateLimiter({ limit: 2, now: () => 0 });
    const guard = createAuthGuard(auth, { publicPaths, rateLimiter: limiter });
    await guard(reqAt({}), mockRes().res);
    await guard(reqAt({}), mockRes().res);
    expect(limiter.check("127.0.0.1").allowed).toBe(false);

    // A valid credential is accepted despite the cooldown — the limiter guards
    // GUESSING, not the operator who already holds the token.
    const ok = mockRes();
    expect(await guard(reqAt({ authorization: `Bearer ${auth.launchToken}` }), ok.res)).toBe(true);
    expect(ok.state.status).toBeUndefined();

    // …and it cleared the counter: the next failure is a plain 401 again.
    const after = mockRes();
    await guard(reqAt({}), after.res);
    expect(after.state.status).toBe(401);
  });

  it("never counts /health or the query-token exchange as failures", async () => {
    const limiter = createAuthRateLimiter({ limit: 1, now: () => 0 });
    const guard = createAuthGuard(auth, { publicPaths, rateLimiter: limiter });
    // A public path is not an authentication attempt at all.
    const health = mockRes();
    expect(await guard(reqAt({}, "127.0.0.1", "/health"), health.res)).toBe(true);
    expect(limiter.size()).toBe(0);
    // A valid launch-token exchange (302 + cookie) is a success, not a failure.
    // The exchange is a navigation's; a token on a plain API GET is refused
    // like any other non-credential and DOES count (see the GET/HEAD cases).
    const login = mockRes();
    expect(
      await guard(reqAt({ "sec-fetch-mode": "navigate" }, "127.0.0.1", `/?token=${auth.launchToken}`), login.res),
    ).toBe(false);
    expect(login.state.status).toBe(302);
    expect(limiter.size()).toBe(0);
  });

  it("reports every outcome through the onResult hook", async () => {
    const seen: Array<{ ip: string; ok: boolean }> = [];
    const guard = createAuthGuard(
      auth,
      { publicPaths, rateLimiter: createAuthRateLimiter({ limit: 10, now: () => 0 }) },
      { onResult: (ip, ok) => seen.push({ ip, ok }) },
    );
    await guard(reqAt({}, "10.0.0.1"), mockRes().res);
    await guard(reqAt({ authorization: `Bearer ${auth.launchToken}` }, "10.0.0.2"), mockRes().res);
    await guard(reqAt({}, "10.0.0.3", "/health"), mockRes().res);
    expect(seen).toEqual([
      { ip: "10.0.0.1", ok: false },
      { ip: "10.0.0.2", ok: true },
    ]);
  });

  it("keys the count by the socket address unless the proxy is trusted", async () => {
    const limiter = createAuthRateLimiter({ limit: 1, now: () => 0 });
    const guard = createAuthGuard(auth, { publicPaths, rateLimiter: limiter, trustProxy: false });
    const forged = { "x-forwarded-for": "203.0.113.5" };
    await guard(reqAt(forged), mockRes().res);
    // Same forged header again: still the same socket bucket → 429.
    const blocked = mockRes();
    await guard(reqAt(forged), blocked.res);
    expect(blocked.state.status).toBe(429);
    expect(limiter.check("127.0.0.1").allowed).toBe(false);
    expect(limiter.check("203.0.113.5").allowed).toBe(true);

    const trustedLimiter = createAuthRateLimiter({ limit: 1, now: () => 0 });
    const trusted = createAuthGuard(auth, {
      publicPaths,
      rateLimiter: trustedLimiter,
      trustProxy: true,
    });
    await trusted(reqAt(forged), mockRes().res);
    const second = mockRes();
    await trusted(reqAt(forged), second.res);
    expect(second.state.status).toBe(429);
    expect(trustedLimiter.check("203.0.113.5").allowed).toBe(false);
    expect(trustedLimiter.check("127.0.0.1").allowed).toBe(true);
  });

  it("marks the cookie Secure only for an https request", async () => {
    const guard = createAuthGuard(auth, { publicPaths, rateLimiter: createAuthRateLimiter() });
    const plain = mockRes();
    await guard(reqAt({}, "127.0.0.1", `/?token=${auth.launchToken}`), plain.res);
    expect(String(plain.state.headers?.["Set-Cookie"])).not.toMatch(/;\s*Secure/i);
  });
});
