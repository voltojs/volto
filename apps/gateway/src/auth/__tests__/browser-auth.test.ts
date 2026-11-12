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

/** Authorization outcome, awaited — `authorize` resolves the token generation. */
function authorize(
  auth: import("../browser-auth.js").BrowserAuth,
  headers: Record<string, string>,
  url = "/",
) {
  return auth.authorize(reqWith(headers, url));
}

/** The `volto_auth` pair of a freshly minted cookie header. */
async function cookieOf(auth: import("../browser-auth.js").BrowserAuth): Promise<string> {
  return (await auth.cookieHeaderFor(Date.now())).split(";")[0]!;
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
    const cookie = await first.cookieHeaderFor(Date.now());
    const value = cookie.split(";")[0]!;

    // A second instance over the same dir must accept the first one's cookie.
    const second = await createBrowserAuth({ dir });
    expect((await authorize(second, { cookie: value })).ok).toBe(true);
  });

  it("accepts a valid launch token and asks the caller to redirect to a clean url", async () => {
    const auth = await createBrowserAuth({ dir });
    const result = await authorize(auth, {}, `/?token=${auth.launchToken}`);

    expect(result.ok).toBe(false);
    expect(result.redirectTo).toBe("/");
    expect(result.setCookie).toBeDefined();
    // The token must not survive in the address bar.
    expect(result.redirectTo).not.toContain("token");
  });

  it("issues an HttpOnly SameSite=Strict cookie", async () => {
    const auth = await createBrowserAuth({ dir });
    const cookie = await auth.cookieHeaderFor(Date.now());
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
  });

  it("accepts a bearer token", async () => {
    const auth = await createBrowserAuth({ dir });
    expect((await authorize(auth, { authorization: `Bearer ${auth.launchToken}` })).ok).toBe(true);
  });

  it("rejects a tampered cookie", async () => {
    const auth = await createBrowserAuth({ dir });
    const cookie = await cookieOf(auth);
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`;
    expect((await authorize(auth, { cookie: tampered })).ok).toBe(false);
  });

  it("rejects a cookie signed by a different secret", async () => {
    const other = await fsp.mkdtemp(path.join(os.tmpdir(), "volto-auth-other-"));
    const foreign = await createBrowserAuth({ dir: other });
    const auth = await createBrowserAuth({ dir });

    const cookie = await cookieOf(foreign);
    expect((await authorize(auth, { cookie })).ok).toBe(false);

    await fsp.rm(other, { recursive: true, force: true });
  });

  it("rejects an expired cookie", async () => {
    const auth = await createBrowserAuth({ dir, maxAgeDays: 1 });
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const cookie = (await auth.cookieHeaderFor(twoDaysAgo)).split(";")[0]!;
    expect((await authorize(auth, { cookie })).ok).toBe(false);
  });

  it("rejects an empty or absent credential", async () => {
    const auth = await createBrowserAuth({ dir });
    expect((await auth.authorize(reqWith({}))).ok).toBe(false);
    expect((await auth.authorize(reqWith({ cookie: "" }))).ok).toBe(false);
    expect((await auth.authorize(reqWith({ authorization: "Bearer " }))).ok).toBe(false);
  });

  it("falls through to the query token when the cookie header has no volto_auth", async () => {
    const auth = await createBrowserAuth({ dir });
    const result = await auth.authorize(
      reqWith({ cookie: "other=1; theme=dark" }, `/?token=${auth.launchToken}`),
    );
    expect(result.ok).toBe(false);
    expect(result.redirectTo).toBe("/");
    expect(result.setCookie).toBeDefined();
  });

  it("fail-closes on a present but invalid volto_auth when no valid token is offered", async () => {
    const auth = await createBrowserAuth({ dir });
    const cookie = await cookieOf(auth);
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`;
    const result = await authorize(auth, { cookie: tampered });
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
    const staleCookie = await cookieOf(stale);

    const rotated = await createBrowserAuth({ dir: await freshDir() });
    const result = await rotated.authorize(
      reqWith({ cookie: staleCookie }, `/?token=${rotated.launchToken}`),
    );

    expect(result.redirectTo).toBe("/");
    expect(result.setCookie).toBeDefined();
  });

  it("does not let a wrong query token lock out a caller holding a good cookie", async () => {
    // The flip side of the reorder: `?token=wrong` must fall through rather
    // than fail closed, or any crafted link becomes a logout button.
    const auth = await createBrowserAuth({ dir });
    const cookie = await cookieOf(auth);
    const result = await auth.authorize(reqWith({ cookie }, "/sessions?token=wrong"));
    expect(result.ok).toBe(true);
  });

  it("falls through to the query token when Authorization is not Bearer", async () => {
    const auth = await createBrowserAuth({ dir });
    const result = await auth.authorize(
      reqWith({ authorization: "Basic dXNlcjpwYXNz" }, `/?token=${auth.launchToken}`),
    );
    expect(result.ok).toBe(false);
    expect(result.redirectTo).toBe("/");
    expect(result.setCookie).toBeDefined();
  });

  it("rotate 后旧 cookie 立即失效", async () => {
    const authDir = await mkdtemp(path.join(tmpdir(), "volto-auth-"));
    const auth1 = await createBrowserAuth({ dir: authDir });
    const cookie = await cookieOf(auth1);
    expect((await authorize(auth1, { cookie })).ok).toBe(true);

    const rotated = await createBrowserAuth({
      dir: authDir,
      accessToken: await rotateAccessToken(authDir),
    });
    expect((await authorize(rotated, { cookie })).ok).toBe(false);
  });

  it("access token 可作为 bearer", async () => {
    const authDir = await mkdtemp(path.join(tmpdir(), "volto-auth-"));
    const auth = await createBrowserAuth({ dir: authDir });
    expect((await authorize(auth, { authorization: `Bearer ${auth.accessToken}` })).ok).toBe(true);
  });

  it("access token 可作为 query token 换取 cookie", async () => {
    const authDir = await mkdtemp(path.join(tmpdir(), "volto-auth-"));
    const auth = await createBrowserAuth({ dir: authDir });
    // The `volto token` / `volto web` login URL: it mints the cookie and
    // redirects to a clean root, exactly like the per-process launch token.
    const result = await auth.authorize(reqWith({}, `/?token=${auth.accessToken}`));
    expect(result.redirectTo).toBe("/");
    expect(result.setCookie).toBeDefined();
    // The minted cookie is immediately usable and can be replayed by a
    // later instance over the same config dir.
    const minted = result.setCookie!.split(";")[0]!;
    expect((await auth.authorize(reqWith({ cookie: minted }))).ok).toBe(true);
    const restarted = await createBrowserAuth({ dir: authDir });
    expect((await restarted.authorize(reqWith({ cookie: minted }))).ok).toBe(true);
  });

  it("rejects the pre-rotation access token as a bearer after rotation", async () => {
    const authDir = await mkdtemp(path.join(tmpdir(), "volto-auth-"));
    const auth = await createBrowserAuth({ dir: authDir });
    const oldToken = auth.accessToken;
    const fresh = await rotateAccessToken(authDir);
    const rotated = await createBrowserAuth({ dir: authDir });
    expect(rotated.accessToken).toBe(fresh);
    expect((await rotated.authorize(reqWith({ authorization: `Bearer ${oldToken}` }))).ok).toBe(false);
    expect((await rotated.authorize(reqWith({ authorization: `Bearer ${fresh}` }))).ok).toBe(true);
    // The per-process launch token keeps working across a rotation: it is
    // not derived from the persisted file.
    expect((await rotated.authorize(reqWith({ authorization: `Bearer ${rotated.launchToken}` }))).ok).toBe(
      true,
    );
  });

  it("invalidates a cookie on rotation WITHOUT rebuilding the auth (R26)", async () => {
    // A rotation that only takes effect after a restart is a security
    // control you cannot count on. The SAME auth object must see it.
    const authDir = await mkdtemp(path.join(tmpdir(), "volto-auth-"));
    const auth = await createBrowserAuth({ dir: authDir });
    const cookie = await cookieOf(auth);
    expect((await authorize(auth, { cookie })).ok).toBe(true);

    const rotatedToken = await rotateAccessToken(authDir);

    expect((await authorize(auth, { cookie })).ok).toBe(false);
    // The old bearer is gone too, and the new one is live — same instance.
    expect((await authorize(auth, { authorization: `Bearer ${auth.accessToken}` })).ok).toBe(false);
    expect((await authorize(auth, { authorization: `Bearer ${rotatedToken}` })).ok).toBe(true);
    // The new token exchanges for a cookie that works, through the same object.
    const login = await auth.authorize(reqWith({}, `/?token=${rotatedToken}`));
    expect(login.redirectTo).toBe("/");
    const fresh = login.setCookie!.split(";")[0]!;
    expect((await auth.authorize(reqWith({ cookie: fresh }))).ok).toBe(true);
  });

  it("fails closed when the token file disappears mid-flight (R26)", async () => {
    const authDir = await mkdtemp(path.join(tmpdir(), "volto-auth-"));
    const auth = await createBrowserAuth({ dir: authDir });
    const cookie = await cookieOf(auth);
    expect((await authorize(auth, { cookie })).ok).toBe(true);

    await fsp.rm(path.join(authDir, "access-token"));

    // Never fall back to the last known generation: the operator deleted the
    // token, so every cookie it authorized is dead right now.
    expect((await authorize(auth, { cookie })).ok).toBe(false);
    // And a cookie cannot even be minted without a live generation.
    await expect(auth.cookieHeaderFor(Date.now())).rejects.toThrow(/access token file/);
  });

  it("re-reads a token that is restored after deletion, without a rebuild", async () => {
    // The complement of fail-closed: once a token is back on disk, that new
    // generation is authoritative again — the cache must not stay poisoned.
    const authDir = await mkdtemp(path.join(tmpdir(), "volto-auth-"));
    const auth = await createBrowserAuth({ dir: authDir });
    // Mint while the token is present — a cookie cannot exist otherwise.
    const stale = await cookieOf(auth);
    const tokenPath = path.join(authDir, "access-token");
    const original = await fsp.readFile(tokenPath, "utf-8");

    await fsp.rm(tokenPath);
    expect((await authorize(auth, { cookie: stale })).ok).toBe(false);

    await fsp.writeFile(tokenPath, original, { mode: 0o600 });
    const restored = await cookieOf(auth);
    // The same generation came back, so the original cookie is live again —
    // the cache was dropped on the failed read, not left poisoned.
    expect((await authorize(auth, { cookie: stale })).ok).toBe(true);
    expect((await authorize(auth, { cookie: restored })).ok).toBe(true);
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
