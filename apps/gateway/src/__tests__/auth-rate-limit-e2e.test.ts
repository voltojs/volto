/**
 * Rate limiting of FAILED authentication (R29), and the two shipped wiring
 * decisions around it:
 *
 * 1. **No lockout behind a tunnel.** cloudflared / ngrok connect from
 *    loopback, so every request's socket address is 127.0.0.1. With
 *    `trustProxy: false` the accounting is by that socket address — a forged
 *    `X-Forwarded-For` cannot move it — so an attacker guessing tokens cannot
 *    pin the count on a named victim. With `trustProxy: true` the first
 *    forwarded hop is the key, and two forwarded clients are limited
 *    independently.
 * 2. **Limits fail closed per IP, successes clear.** The limits here are
 *    intentionally small so the e2e cases are cheap; the shipped defaults
 *    (10 / 60s / 60s) are pinned by rate-limit.test.ts on an injected clock.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import type { ModelPort } from "@voltojs/core";
import { createServer, type ServerOptions } from "../server.js";
import { cookieAttributesFor } from "../auth/middleware.js";
import { createAuthRateLimiter } from "../auth/rate-limit.js";

const execFileAsync = promisify(execFile);

/** A throwaway self-signed certificate, generated once per test run. */
let tlsFixture: Promise<{ key: Buffer; cert: Buffer }> | undefined;
function tlsCert(): Promise<{ key: Buffer; cert: Buffer }> {
  tlsFixture ??= (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-tls-"));
    const keyFile = path.join(dir, "key.pem");
    const certFile = path.join(dir, "cert.pem");
    await execFileAsync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=127.0.0.1",
      "-keyout", keyFile, "-out", certFile,
    ]);
    const pair = { key: await fs.readFile(keyFile), cert: await fs.readFile(certFile) };
    await fs.rm(dir, { recursive: true, force: true });
    return pair;
  })();
  return tlsFixture;
}

const MOCK_MODEL: ModelPort = {
  async *stream() {
    yield { type: "done", stopReason: "end_turn" };
  },
};

interface Started {
  server: http.Server;
  port: number;
  token: string;
  close: () => Promise<void>;
}

/** Thin wrapper over `createServer` with the options these tests vary. */
async function start(opts: ServerOptions = {}): Promise<Started> {
  process.env["VOLTO_CONFIG_DIR"] = await fs.mkdtemp(path.join(os.tmpdir(), "volto-rl-"));
  const server = await createServer({
    port: 0,
    modelPort: MOCK_MODEL,
    // Small limits keep the e2e cases cheap; the shipped defaults are
    // asserted separately on the limiter.
    rateLimit: { limit: 3 },
    ...opts,
  });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    port,
    token: server.launchToken,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A browser document navigation. The guard only redirects one of these (a
 * token-bearing API call or POST is never bounced), and a navigation is what
 * the login link actually is, so the cookie cases below present as one.
 */
const NAVIGATE = { "Sec-Fetch-Mode": "navigate", Accept: "text/html,application/xhtml+xml" };

function request(
  port: number,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "GET", headers: { ...NAVIGATE, ...headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** One failed authentication: no credential at all, from `xff` if given. */
function failAuth(port: number, xff?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return request(port, "/projects", xff === undefined ? {} : { "X-Forwarded-For": xff });
}

function authHeaders(token: string, xff?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...(xff === undefined ? {} : { "X-Forwarded-For": xff }),
  };
}

describe("rate limiting failed auth (R29)", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start();
  });
  afterAll(() => s.close());

  it("answers 401 while under the limit and 429 with Retry-After once over it", async () => {
    const first = await failAuth(s.port);
    expect(first.status).toBe(401);
    expect(first.body).toBe(JSON.stringify({ error: "Unauthorized" }));

    // limit: 3 → the third failure trips it.
    expect((await failAuth(s.port)).status).toBe(401);
    expect((await failAuth(s.port)).status).toBe(401);
    const blocked = await failAuth(s.port);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.body).toBe(JSON.stringify({ error: "Unauthorized" }));

    // Still blocked on the next attempt, with a fresh (smaller) Retry-After.
    const again = await failAuth(s.port);
    expect(again.status).toBe(429);
    expect(Number(again.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("does not rate-limit /health (it is unauthenticated by design)", async () => {
    // Same socket IP as every failure above.
    const health = await request(s.port, "/health");
    expect(health.status).toBe(200);
    expect(health.body).toBe(JSON.stringify({ status: "ok" }));
  });

  it("does not rate-limit the static shell — the login page must stay reachable", async () => {
    // No web build in the temp config dir, but the request is answered by the
    // static host (503 "web app not found") rather than by the limiter.
    const shell = await request(s.port, "/");
    expect([200, 503]).toContain(shell.status);
  });

  it("lets a valid credential through even from a blocked IP, and clears the counter", async () => {
    const blocked = await failAuth(s.port);
    expect(blocked.status).toBe(429);

    const ok = await request(s.port, "/projects", authHeaders(s.token));
    expect(ok.status).toBe(200);

    // Success cleared the counter: the next failure is a plain 401 again.
    expect((await failAuth(s.port)).status).toBe(401);
  });
});

describe("no lockout: trustProxy off counts by socket address", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start({ trustProxy: false });
  });
  afterAll(() => s.close());

  it("a forged X-Forwarded-For cannot pin the count on another client", async () => {
    // The attacker guesses tokens while naming a victim in X-Forwarded-For.
    for (let i = 0; i < 3; i++) {
      expect((await failAuth(s.port, "203.0.113.50")).status).toBe(401);
    }
    // The header is not trusted, so there is no bucket named 203.0.113.50 to
    // pin: the count sits on the socket, where the attacker keeps extending
    // it. A DIFFERENT forwarded address from the same socket gets no fresh
    // budget either. Only the credential lifts the cooldown.
    expect((await failAuth(s.port, "198.51.100.99")).status).toBe(429);

    // A correct credential still works from that same socket — no lockout:
    // success is the escape hatch, always.
    const ok = await request(s.port, "/projects", authHeaders(s.token, "198.51.100.99"));
    expect(ok.status).toBe(200);

    // …and the success cleared the socket's counter, so a failure is answered
    // by the credential check again rather than by the limiter.
    expect((await failAuth(s.port, "203.0.113.50")).status).toBe(401);
  });

  it("never lets a forged header exempt the attacker", async () => {
    // A fresh server (fresh counts): the attacker rotates the header on every
    // attempt. With trustProxy off they all land on one bucket, so rotating
    // buys nothing.
    const fresh = await start({ trustProxy: false });
    try {
      for (let i = 0; i < 3; i++) {
        expect((await failAuth(fresh.port, `10.9.9.${i}`)).status).toBe(401);
      }
      expect((await failAuth(fresh.port, "10.9.9.200")).status).toBe(429);
    } finally {
      await fresh.close();
    }
  });
});

describe("trustProxy on: two forwarded clients are limited independently", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start({ trustProxy: true });
  });
  afterAll(() => s.close());

  it("blocks one forwarded IP without touching the other", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await failAuth(s.port, "203.0.113.1")).status).toBe(401);
    }
    expect((await failAuth(s.port, "203.0.113.1")).status).toBe(429);

    // A different forwarded client is unaffected.
    expect((await failAuth(s.port, "203.0.113.2")).status).toBe(401);
    // The limiter guards FAILED attempts: a valid credential from the blocked
    // IP is still accepted, and it clears that IP's bucket.
    const ok = await request(s.port, "/projects", authHeaders(s.token, "203.0.113.1"));
    expect(ok.status).toBe(200);
    expect((await failAuth(s.port, "203.0.113.1")).status).toBe(401);
  });
});

describe("cookie Secure flag follows the real request protocol", () => {
  it("is absent on plain http", async () => {
    const s = await start();
    try {
      const login = await request(s.port, `/?token=${s.token}`);
      expect(login.status).toBe(302);
      const cookie = String(login.headers["set-cookie"]);
      expect(cookie).toContain("volto_auth=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).not.toMatch(/;\s*Secure/i);
    } finally {
      await s.close();
    }
  });

  it("is set when X-Forwarded-Proto: https and the proxy is trusted", async () => {
    const s = await start({ trustProxy: true });
    try {
      const login = await request(s.port, `/?token=${s.token}`, { "X-Forwarded-Proto": "https" });
      expect(login.status).toBe(302);
      expect(String(login.headers["set-cookie"])).toMatch(/;\s*Secure/i);
    } finally {
      await s.close();
    }
  });

  it("is not set from an untrusted X-Forwarded-Proto", async () => {
    const s = await start({ trustProxy: false });
    try {
      const login = await request(s.port, `/?token=${s.token}`, { "X-Forwarded-Proto": "https" });
      expect(login.status).toBe(302);
      expect(String(login.headers["set-cookie"])).not.toMatch(/;\s*Secure/i);
    } finally {
      await s.close();
    }
  });

  it("cookieAttributesFor marks Secure on a direct TLS socket", async () => {
    // A real TLS server, so `req.socket.encrypted` is the genuine article —
    // the guard turns it into the `; Secure` attribute the browser sees.
    const { key, cert } = await tlsCert();
    const seen: string[] = [];
    const tls = https.createServer(
      { key, cert },
      (req, res) => {
        // What the guard would append to the Set-Cookie it forwards…
        seen.push(cookieAttributesFor(req, { trustProxy: false }));
        // …with the same observed protocol echoed back for assertion.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ secure: seen[seen.length - 1] }));
      },
    );
    await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
    const port = (tls.address() as { port: number }).port;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        https
          .get({ host: "127.0.0.1", port, path: "/", rejectUnauthorized: false }, (res) => {
            let out = "";
            res.setEncoding("utf-8");
            res.on("data", (chunk: string) => {
              out += chunk;
            });
            res.on("end", () => resolve(out));
          })
          .on("error", reject);
      });
      expect(JSON.parse(body)).toEqual({ secure: "; Secure" });
    } finally {
      await new Promise<void>((resolve) => tls.close(() => resolve()));
    }
  });
});

describe("rate limiter is injectable end to end", () => {
  it("hands the shipped limiter its clock through ServerOptions", () => {
    // The seam ServerOptions.rateLimit.now relies on: the same factory, driven
    // by an injected clock, is what server.ts constructs by default.
    const t = 0;
    const rl = createAuthRateLimiter({ now: () => t });
    expect(rl.check("ip")).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it("mounts an injected limiter on the real HTTP chain", async () => {
    const rl = createAuthRateLimiter({ limit: 1, now: () => 0 });
    const s = await start({ rateLimit: { limiter: rl } });
    try {
      expect((await failAuth(s.port)).status).toBe(401);
      expect((await failAuth(s.port)).status).toBe(429);
      // …and the bucket is keyed by the socket address, as the default is.
      expect(rl.check("127.0.0.1").allowed).toBe(false);
    } finally {
      await s.close();
    }
  });
});
describe("the WS upgrade is the same guess channel", () => {
  it("counts failed upgrades and answers 429 once over the limit", async () => {
    // Without this a client would simply move its guessing to /ws, which does
    // not go through the HTTP guard at all.
    const s = await start({ rateLimit: { limit: 2 } });
    try {
      const attempt = (): Promise<number> =>
        new Promise<number>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws?message=hi`);
          ws.on("open", () => {
            ws.close();
            resolve(101);
          });
          // `ws` reports a refused handshake here rather than as an error.
          ws.on("unexpected-response", (_req, res) => {
            resolve(res.statusCode ?? 0);
          });
          ws.on("error", () => resolve(-1));
        });
      expect(await attempt()).toBe(401);
      expect(await attempt()).toBe(401);
      expect(await attempt()).toBe(429);
    } finally {
      await s.close();
    }
  });
});
