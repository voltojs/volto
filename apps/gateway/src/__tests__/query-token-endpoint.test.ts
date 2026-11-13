/**
 * The query token at the HTTP endpoint, over the real request chain.
 *
 * Three rules, and the plain-HTTP client here pins the observable part of
 * each one (the guard's own unit cases live in `auth/__tests__/middleware.test.ts`):
 *
 * - a browser document navigation trades a valid `?token=` for the session
 *   cookie and is sent to the SAME URL without the parameter, so the
 *   credential never sits in history, the referrer or a tunnel's log;
 * - a navigation that already holds the session loses the parameter too, on
 *   ANY page -- not just `/` -- and nothing is minted for it;
 * - a request that cannot be redirected (a POST, a programmatic fetch) keeps
 *   its body and gets the uniform 401 instead. That is what makes the
 *   exchange method-aware rather than a redirect that silently drops it.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelPort } from "@voltojs/core";
import { createServer, type HeadlessServer } from "../server.js";

const MODEL_PORT: ModelPort = {
  async *stream() {
    yield { type: "done", stopReason: "end_turn" };
  },
};

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: HeadlessServer;
let port: number;
let launchToken: string;

beforeAll(async () => {
  process.env["VOLTO_CONFIG_DIR"] = await fs.mkdtemp(path.join(os.tmpdir(), "volto-token-e2e-"));
  // No web build for this deployment: a navigation to the shell is a 503,
  // which is irrelevant here -- only the guard's answer is asserted.
  server = await createServer({ port: 0, modelPort: MODEL_PORT, log: () => undefined });
  launchToken = server.launchToken;
  await new Promise<void>((resolve) => server.on("listening", () => {
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
    resolve();
  }));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * One request with EXACTLY these headers. `fetch` is unusable here: it
 * overwrites `sec-fetch-mode` with `cors` and follows (or erases) a redirect
 * for a POST, either of which would hide what the gateway wrote.
 */
function send(
  target: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  const method = opts.method ?? "GET";
  const body = opts.body ?? "";
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: target,
        method,
        headers: {
          ...(body === "" ? {} : { "content-length": String(Buffer.byteLength(body)) }),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** A Chrome/Safari document navigation. */
function navigate(target: string, headers: Record<string, string> = {}): Promise<Reply> {
  return send(target, {
    headers: { "sec-fetch-mode": "navigate", accept: "text/html,application/xhtml+xml", ...headers },
  });
}

function sessionCookie(reply: Reply): string {
  const pair = (reply.headers["set-cookie"] ?? [])[0]?.split(";")[0] ?? "";
  expect(pair).toContain("volto_auth=");
  return pair;
}

describe("?token= at the endpoint", () => {
  it("an unauthenticated navigation exchanges it for a cookie and the clean URL", async () => {
    const login = await navigate(`/?token=${launchToken}`);
    expect(login.status).toBe(302);
    expect(login.headers.location).toBe("/");
    expect(sessionCookie(login).length).toBeGreaterThan(0);
    expect(login.headers["cache-control"]).toBe("no-store");
  });

  it("an authenticated navigation has the parameter stripped from ANY page", async () => {
    const cookie = sessionCookie(await navigate(`/?token=${launchToken}`));
    // A deep link, not just the root: the redirect keeps the path and every
    // other query parameter, and drops only `token`.
    const cleaned = await navigate(`/sessions/abc?tab=plan&token=${launchToken}`, { cookie });
    expect(cleaned.status).toBe(302);
    expect(cleaned.headers.location).toBe("/sessions/abc?tab=plan");
    // The token was NOT traded for a fresh session: the cookie that comes back
    // is bound to the same token generation the caller's own cookie carries.
    // (An auto-renewal re-signs it with a later expiry, so the bytes differ;
    // what must not change is the `tv` generation inside.)
    const generationOf = (setCookie: string | undefined): string => {
      const value = (setCookie ?? "").split(";")[0]?.split("=")[1] ?? "";
      const payload = JSON.parse(Buffer.from(value.split(".")[0] ?? "", "base64url").toString("utf-8")) as {
        tv: string;
      };
      return payload.tv;
    };
    expect(generationOf((cleaned.headers["set-cookie"] ?? [])[0])).toBe(generationOf(cookie));
  });

  it("an unauthenticated navigation with a bad token gets the uniform 401, no redirect", async () => {
    const bad = await navigate("/?token=not-a-token");
    expect(bad.status).toBe(401);
    expect(bad.headers.location).toBeUndefined();
    expect(bad.body).toBe(JSON.stringify({ error: "Unauthorized" }));
  });

  it("a POST carrying a valid ?token= is 401 with its body intact, never redirected", async () => {
    const posted = await send(`/messages?token=${launchToken}&sessionId=s`, {
      method: "POST",
      headers: { "sec-fetch-mode": "navigate", "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s", message: "hello" }),
    });
    expect(posted.status).toBe(401);
    expect(posted.headers.location).toBeUndefined();
    expect(posted.headers["set-cookie"]).toBeUndefined();
    // Same acceptance as any other refusal: the body says nothing about why.
    expect(posted.body).toBe(JSON.stringify({ error: "Unauthorized" }));
  });

  it("a programmatic fetch carrying a token is not bounced either", async () => {
    const api = await send(`/projects?token=${launchToken}`, {
      headers: { "sec-fetch-mode": "cors", accept: "application/json" },
    });
    expect(api.status).toBe(401);
    expect(api.headers.location).toBeUndefined();
  });

  it("a navigation without a token is never redirected", async () => {
    const plain = await navigate("/");
    expect(plain.status).not.toBe(302);
    expect(plain.headers.location).toBeUndefined();
  });
});