import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createBrowserAuth, type BrowserAuth } from "../browser-auth.js";
import { createAuthGuard, isAuthorized } from "../middleware.js";
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
    expect(await guard(reqWith({}, `/?token=${auth.launchToken}`), res)).toBe(false);
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
    const login = mockRes();
    expect(await guard(reqAt({}, "127.0.0.1", `/?token=${auth.launchToken}`), login.res)).toBe(false);
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
