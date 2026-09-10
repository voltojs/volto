import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createBrowserAuth, type BrowserAuth } from "../browser-auth.js";
import { createAuthGuard, isAuthorized } from "../middleware.js";

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

  it("allows a public path with no credentials", () => {
    const guard = createAuthGuard(auth, { publicPaths });
    const { res, state } = mockRes();
    expect(guard(reqWith({}, "/health"), res)).toBe(true);
    expect(state.status).toBeUndefined();
  });

  it("allows an authenticated bearer request", () => {
    const guard = createAuthGuard(auth, { publicPaths });
    const { res, state } = mockRes();
    expect(guard(reqWith({ authorization: `Bearer ${auth.launchToken}` }, "/projects"), res)).toBe(
      true,
    );
    expect(state.status).toBeUndefined();
  });

  it("rejects an unauthenticated request with the uniform 401 body", () => {
    const guard = createAuthGuard(auth, { publicPaths });
    const { res, state } = mockRes();
    expect(guard(reqWith({}, "/providers"), res)).toBe(false);
    expect(state.status).toBe(401);
    expect(state.body).toBe(JSON.stringify({ error: "Unauthorized" }));
  });

  it("answers an unknown route with the same 401 body as a known one", () => {
    const guard = createAuthGuard(auth, { publicPaths });
    const known = mockRes();
    const unknown = mockRes();
    guard(reqWith({}, "/providers"), known.res);
    guard(reqWith({}, "/nonexistent-route"), unknown.res);
    expect(known.state.status).toBe(unknown.state.status);
    expect(known.state.body).toBe(unknown.state.body);
  });

  it("exchanges a valid query token for a cookie and a clean redirect", () => {
    const guard = createAuthGuard(auth, { publicPaths });
    const { res, state } = mockRes();
    expect(guard(reqWith({}, `/?token=${auth.launchToken}`), res)).toBe(false);
    expect(state.status).toBe(302);
    expect(state.headers?.["Location"]).toBe("/");
    expect(String(state.headers?.["Set-Cookie"])).toContain("volto_auth=");
  });

  it("rejects an invalid bearer token with the same 401 as a missing one", () => {
    const guard = createAuthGuard(auth, { publicPaths });
    const missing = mockRes();
    const invalid = mockRes();
    guard(reqWith({}, "/projects"), missing.res);
    guard(reqWith({ authorization: "Bearer not-the-token" }, "/projects"), invalid.res);
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
