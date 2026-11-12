import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createBrowserAuth } from "../browser-auth.js";
import { rotateAccessToken } from "../access-token.js";

let dir: string;
const extraDirs: string[] = [];

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "volto-auth-"));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
  await Promise.all(extraDirs.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

/** A second config dir, so a test can rotate the signing secret. */
async function freshDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "volto-auth-alt-"));
  extraDirs.push(d);
  return d;
}

function reqWith(headers: Record<string, string>, url = "/") {
  return { url, headers } as unknown as import("node:http").IncomingMessage;
}

describe("createBrowserAuth", () => {
  it("mints a launch token that is not guessable-short", async () => {
    const auth = await createBrowserAuth({ dir });
    expect(auth.launchToken.length).toBeGreaterThanOrEqual(32);
  });

  it("puts the token on the root url as its only auth input", async () => {
    const auth = await createBrowserAuth({ dir });
    const url = new URL(auth.authenticatedUrl("http://localhost:3100/ignored?a=b#c"));
    expect(url.pathname).toBe("/");
    expect(url.hash).toBe("");
    expect(url.searchParams.get("token")).toBe(auth.launchToken);
    expect([...url.searchParams.keys()]).toEqual(["token"]);
  });

  it("persists its signing secret across instances", async () => {
    const first = await createBrowserAuth({ dir });
    const cookie = first.cookieHeaderFor(Date.now());
    const value = cookie.split(";")[0]!;

    // A second instance over the same dir must accept the first one's cookie.
    const second = await createBrowserAuth({ dir });
    expect(second.authorize(reqWith({ cookie: value })).ok).toBe(true);
  });

  it("accepts a valid launch token and asks the caller to redirect to a clean url", async () => {
    const auth = await createBrowserAuth({ dir });
    const result = auth.authorize(reqWith({}, `/?token=${auth.launchToken}`));

    expect(result.ok).toBe(false);
    expect(result.redirectTo).toBe("/");
    expect(result.setCookie).toBeDefined();
    // The token must not survive in the address bar.
    expect(result.redirectTo).not.toContain("token");
  });

  it("issues an HttpOnly SameSite=Strict cookie", async () => {
    const auth = await createBrowserAuth({ dir });
    const cookie = auth.cookieHeaderFor(Date.now());
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
  });

  it("accepts a bearer token", async () => {
    const auth = await createBrowserAuth({ dir });
    expect(auth.authorize(reqWith({ authorization: `Bearer ${auth.launchToken}` })).ok).toBe(true);
  });

  it("rejects a tampered cookie", async () => {
    const auth = await createBrowserAuth({ dir });
    const cookie = auth.cookieHeaderFor(Date.now()).split(";")[0]!;
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`;
    expect(auth.authorize(reqWith({ cookie: tampered })).ok).toBe(false);
  });

  it("rejects a cookie signed by a different secret", async () => {
    const other = await fsp.mkdtemp(path.join(os.tmpdir(), "volto-auth-other-"));
    const foreign = await createBrowserAuth({ dir: other });
    const auth = await createBrowserAuth({ dir });

    const cookie = foreign.cookieHeaderFor(Date.now()).split(";")[0]!;
    expect(auth.authorize(reqWith({ cookie })).ok).toBe(false);

    await fsp.rm(other, { recursive: true, force: true });
  });

  it("rejects an expired cookie", async () => {
    const auth = await createBrowserAuth({ dir, maxAgeDays: 1 });
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const cookie = auth.cookieHeaderFor(twoDaysAgo).split(";")[0]!;
    expect(auth.authorize(reqWith({ cookie })).ok).toBe(false);
  });

  it("rejects an empty or absent credential", async () => {
    const auth = await createBrowserAuth({ dir });
    expect(auth.authorize(reqWith({})).ok).toBe(false);
    expect(auth.authorize(reqWith({ cookie: "" })).ok).toBe(false);
    expect(auth.authorize(reqWith({ authorization: "Bearer " })).ok).toBe(false);
  });

  it("falls through to the query token when the cookie header has no volto_auth", async () => {
    const auth = await createBrowserAuth({ dir });
    const result = auth.authorize(
      reqWith({ cookie: "other=1; theme=dark" }, `/?token=${auth.launchToken}`),
    );
    expect(result.ok).toBe(false);
    expect(result.redirectTo).toBe("/");
    expect(result.setCookie).toBeDefined();
  });

  it("fail-closes on a present but invalid volto_auth when no valid token is offered", async () => {
    const auth = await createBrowserAuth({ dir });
    const cookie = auth.cookieHeaderFor(Date.now()).split(";")[0]!;
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`;
    const result = auth.authorize(reqWith({ cookie: tampered }));
    expect(result.ok).toBe(false);
    expect(result.setCookie).toBeUndefined();
    expect(result.redirectTo).toBeUndefined();
  });

  it("lets a valid launch token override a stale cookie", async () => {
    // Reproduced live before the fix: rotate the signing secret and the
    // browser keeps presenting its old, unexpired cookie. With the cookie
    // checked first, that dead cookie beat a brand-new valid launch URL and
    // the page showed a bare {"error":"Unauthorized"} — HttpOnly and a
    // 7-day Max-Age left no way to clear it from the app itself.
    const stale = await createBrowserAuth({ dir });
    const staleCookie = stale.cookieHeaderFor(Date.now()).split(";")[0]!;

    const rotated = await createBrowserAuth({ dir: await freshDir() });
    const result = rotated.authorize(
      reqWith({ cookie: staleCookie }, `/?token=${rotated.launchToken}`),
    );

    expect(result.redirectTo).toBe("/");
    expect(result.setCookie).toBeDefined();
  });

  it("does not let a wrong query token lock out a caller holding a good cookie", async () => {
    // The flip side of the reorder: `?token=wrong` must fall through rather
    // than fail closed, or any crafted link becomes a logout button.
    const auth = await createBrowserAuth({ dir });
    const cookie = auth.cookieHeaderFor(Date.now()).split(";")[0]!;
    const result = auth.authorize(reqWith({ cookie }, "/sessions?token=wrong"));
    expect(result.ok).toBe(true);
  });

  it("falls through to the query token when Authorization is not Bearer", async () => {
    const auth = await createBrowserAuth({ dir });
    const result = auth.authorize(
      reqWith({ authorization: "Basic dXNlcjpwYXNz" }, `/?token=${auth.launchToken}`),
    );
    expect(result.ok).toBe(false);
    expect(result.redirectTo).toBe("/");
    expect(result.setCookie).toBeDefined();
  });

  it("rotate 后旧 cookie 立即失效", async () => {
    const authDir = await mkdtemp(path.join(tmpdir(), "volto-auth-"));
    const auth1 = await createBrowserAuth({ dir: authDir });
    const cookie = auth1.cookieHeaderFor(Date.now()).split(";")[0]!;
    expect(auth1.authorize(reqWith({ cookie })).ok).toBe(true);

    const rotated = await createBrowserAuth({
      dir: authDir,
      accessToken: await rotateAccessToken(authDir),
    });
    expect(rotated.authorize(reqWith({ cookie })).ok).toBe(false);
  });

  it("access token 可作为 bearer", async () => {
    const authDir = await mkdtemp(path.join(tmpdir(), "volto-auth-"));
    const auth = await createBrowserAuth({ dir: authDir });
    expect(auth.authorize(reqWith({ authorization: `Bearer ${auth.accessToken}` })).ok).toBe(true);
  });

  it("access token 可作为 query token 换取 cookie", async () => {
    const authDir = await mkdtemp(path.join(tmpdir(), "volto-auth-"));
    const auth = await createBrowserAuth({ dir: authDir });
    // The `volto token` / `volto web` login URL: it mints the cookie and
    // redirects to a clean root, exactly like the per-process launch token.
    const result = auth.authorize(reqWith({}, `/?token=${auth.accessToken}`));
    expect(result.redirectTo).toBe("/");
    expect(result.setCookie).toBeDefined();
    // The minted cookie is immediately usable and can be replayed by a
    // later instance over the same config dir.
    const minted = result.setCookie!.split(";")[0]!;
    expect(auth.authorize(reqWith({ cookie: minted })).ok).toBe(true);
    const restarted = await createBrowserAuth({ dir: authDir });
    expect(restarted.authorize(reqWith({ cookie: minted })).ok).toBe(true);
  });

  it("rejects the pre-rotation access token as a bearer after rotation", async () => {
    const authDir = await mkdtemp(path.join(tmpdir(), "volto-auth-"));
    const auth = await createBrowserAuth({ dir: authDir });
    const oldToken = auth.accessToken;
    const fresh = await rotateAccessToken(authDir);
    const rotated = await createBrowserAuth({ dir: authDir });
    expect(rotated.accessToken).toBe(fresh);
    expect(rotated.authorize(reqWith({ authorization: `Bearer ${oldToken}` })).ok).toBe(false);
    expect(rotated.authorize(reqWith({ authorization: `Bearer ${fresh}` })).ok).toBe(true);
    // The per-process launch token keeps working across a rotation: it is
    // not derived from the persisted file.
    expect(rotated.authorize(reqWith({ authorization: `Bearer ${rotated.launchToken}` })).ok).toBe(
      true,
    );
  });

  it("writes its secret file with owner-only permissions", async () => {
    await createBrowserAuth({ dir });
    const entries = await fsp.readdir(dir);
    const secret = entries.find((e) => e.includes("auth"));
    expect(secret).toBeDefined();
    const stat = await fsp.stat(path.join(dir, secret!));
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
