/**
 * Browser authentication for the headless gateway.
 *
 * Two credentials are accepted, in every entry point (query token, cookie,
 * bearer):
 *
 * - the per-process launch token, never persisted, which dies with the
 *   process; and
 * - the persistent access token (`access-token`, 0600), which survives
 *   restarts so a remote client can be handed a stable credential.
 *
 * A valid query token is exchanged for an HMAC-signed HttpOnly cookie. The
 * cookie payload is versioned and generation-bound — `{ v, exp, tv }`, where
 * `tv` is the fingerprint of the access token it was minted under — so
 * rotating the token invalidates every cookie already issued, immediately
 * rather than when its 7-day Max-Age runs out. Every failure path returns
 * the same result so a caller cannot tell why it was refused.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import * as path from "node:path";
import { ensureConfigDir, getConfigDir } from "../config/paths.js";
import { loadOrCreateAccessToken, tokenFingerprint } from "./access-token.js";

const SECRET_BYTES = 32;
const TOKEN_BYTES = 32;
const DEFAULT_MAX_AGE_DAYS = 7;
const COOKIE_NAME = "volto_auth";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/**
 * Cookie payload version. v1 was `{ exp }` with no generation binding; v2 is
 * `{ v, exp, tv }`. A bump invalidates every older cookie, which is the point:
 * verification demands an exact match.
 */
const COOKIE_PAYLOAD_VERSION = 2;

interface CookiePayload {
  v: typeof COOKIE_PAYLOAD_VERSION;
  exp: number;
  /** tokenFingerprint of the access token this cookie was minted under. */
  tv: string;
}

/**
 * Authorization outcome. `setCookie` / `redirectTo` appear only on the
 * query-token success path; the optional slots on `{ ok: true }` exist so
 * callers can read the fields without first narrowing the union.
 */
export type AuthResult =
  | { ok: true; setCookie?: undefined; redirectTo?: undefined }
  | { ok: false; setCookie?: string; redirectTo?: string };

export interface BrowserAuth {
  /** Per-process launch token. Not persisted; dies with the process. */
  readonly launchToken: string;
  /**
   * Persistent access token for the config directory. Survives restarts;
   * `volto token --rotate` is the only way it changes. Cookies carry the
   * fingerprint of THIS value, so a rotation invalidates them all.
   */
  readonly accessToken: string;
  /** Root URL carrying the launch token as its only auth input. */
  authenticatedUrl(baseUrl: string): string;
  /** Evaluate cookie → bearer → query token. Failures are indistinguishable. */
  authorize(req: IncomingMessage): AuthResult;
  /** Full Set-Cookie header value for a session minted at `now`. */
  cookieHeaderFor(now: number): string;
}

export interface CreateBrowserAuthOptions {
  /**
   * Config directory holding `auth-secret` and `access-token`. Defaults to
   * `getConfigDir()`.
   */
  dir?: string;
  /** Cookie lifetime in days. Default 7. */
  maxAgeDays?: number;
  /**
   * Access token to bind cookies to. Defaults to the one already persisted in
   * `dir` (created on first use), so callers that just read the file — the
   * CLI, a host that prints the login URL — can pass it in and prove both
   * sides agree. Rotation must go through the file; pass the NEW value or
   * omit this option.
   */
  accessToken?: string;
}

/**
 * Constant-time compare. `timingSafeEqual` throws on length mismatch, so we
 * short-circuit first — but still run an equal-length dummy compare so the
 * exception path does not leak the length of the expected value.
 */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function tokensMatch(presented: string, expected: string): boolean {
  return safeEqual(Buffer.from(presented, "utf-8"), Buffer.from(expected, "utf-8"));
}

/** Read the signing secret, generating and persisting it on first use. */
async function loadSecret(dir: string): Promise<Buffer> {
  const secretPath = path.join(dir, "auth-secret");
  let existing: Buffer | null = null;
  try {
    existing = await fs.readFile(secretPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // Missing secret file — fall through and generate one.
  }

  if (existing) {
    if (existing.length !== SECRET_BYTES) {
      throw new Error(
        `Auth secret file is corrupt (expected ${SECRET_BYTES} bytes, got ${existing.length}): ${secretPath}`,
      );
    }
    return existing;
  }

  await ensureConfigDir(dir);
  const generated = crypto.randomBytes(SECRET_BYTES);
  await fs.writeFile(secretPath, generated, { mode: 0o600 });
  // writeFile only applies the mode when creating the file; chmod covers
  // the case where a file already existed with looser permissions.
  await fs.chmod(secretPath, 0o600);
  return generated;
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Pull a named cookie out of a `Cookie:` request header. */
function extractCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * The one place either accepted credential is compared. Both are always
 * compared — no early return — so a caller cannot learn which kind of token
 * it guessed from response timing.
 */
function credentialMatches(presented: string, launchToken: string, accessToken: string): boolean {
  const asLaunch = tokensMatch(presented, launchToken);
  const asAccess = tokensMatch(presented, accessToken);
  return asLaunch || asAccess;
}

function signPayload(payload: string, secret: Buffer): string {
  return crypto.createHmac("sha256", secret).update(payload, "utf-8").digest("base64url");
}

export async function createBrowserAuth(
  opts: CreateBrowserAuthOptions = {},
): Promise<BrowserAuth> {
  const dir = opts.dir ?? getConfigDir();
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const maxAgeMs = maxAgeDays * MS_PER_DAY;
  const maxAgeSec = Math.floor(maxAgeMs / 1000);
  const secret = await loadSecret(dir);
  // The generation every cookie this instance mints is bound to. An injected
  // value is taken as-is (a rotating caller passes the NEW token, or omits it
  // so the file is re-read); otherwise the persisted token is the truth.
  const accessToken = opts.accessToken ?? (await loadOrCreateAccessToken(dir));
  const tokenVersion = tokenFingerprint(accessToken);

  // Fresh every process. A restart invalidates every previously issued URL;
  // that is intentional.
  const launchToken = crypto.randomBytes(TOKEN_BYTES).toString("base64url");

  /**
   * Cookie payload. Adding a field means bumping COOKIE_PAYLOAD_VERSION and
   * rejecting every older version in `verifyCookieValue` — an unversioned
   * `{ exp, tv }` would let a cookie minted by a future release (or by a
   * pre-`tv` release, which carried no generation at all) pass as current.
   */
  function cookieValueFor(now: number): string {
    const exp = now + maxAgeMs;
    const body: CookiePayload = { v: COOKIE_PAYLOAD_VERSION, exp, tv: tokenVersion };
    const payload = Buffer.from(JSON.stringify(body), "utf-8").toString("base64url");
    return `${payload}.${signPayload(payload, secret)}`;
  }

  function cookieHeaderFor(now: number): string {
    const exp = now + maxAgeMs;
    const value = cookieValueFor(now);
    const expires = new Date(exp).toUTCString();
    return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}; Expires=${expires}`;
  }

  /**
   * Verify signature first, then the payload: version, expiry, and the
   * token generation. The generation check is what makes `--rotate` take
   * effect immediately instead of at the cookie's own Max-Age.
   */
  function verifyCookieValue(value: string): boolean {
    const dot = value.indexOf(".");
    if (dot <= 0) return false;
    const payload = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    if (!payload || !sig) return false;

    const expected = signPayload(payload, secret);
    if (!safeEqual(Buffer.from(sig, "utf-8"), Buffer.from(expected, "utf-8"))) {
      return false;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    } catch {
      return false;
    }
    if (typeof parsed !== "object" || parsed === null) return false;
    const { v, exp, tv } = parsed as { v?: unknown; exp?: unknown; tv?: unknown };
    if (v !== COOKIE_PAYLOAD_VERSION) return false;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return false;
    if (exp <= Date.now()) return false;
    if (typeof tv !== "string" || tv === "") return false;
    // Constant-time, like every other credential comparison — a cookie that
    // carries the wrong generation must not leak how it differs.
    return tokensMatch(tv, tokenVersion);
  }

  function authenticatedUrl(baseUrl: string): string {
    const url = new URL(baseUrl);
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    url.searchParams.set("token", launchToken);
    return url.toString();
  }

  function authorize(req: IncomingMessage): AuthResult {
    // 1. Query token FIRST — it is the strongest credential this process
    //    hands out (fresh per process, never persisted), so it has to be
    //    able to override a stale cookie.
    //
    //    Checking it last deadlocked the login: rotate the signing secret
    //    (change VOLTO_CONFIG_DIR, delete a corrupt auth-secret, run a
    //    second instance on the same localhost cookie host) and the browser
    //    still presents its old, unexpired cookie. That cookie fails closed
    //    below, and a brand-new valid launch URL could never get past it —
    //    while the cookie is HttpOnly with a 7-day Max-Age, so the page had
    //    no way to clear it either. The only exit was the browser's own
    //    settings, which nothing in the 401 mentions.
    //
    //    Only a VALID token short-circuits. A wrong or absent one falls
    //    through, so a crafted `?token=wrong` link cannot lock out a caller
    //    who already holds a good cookie.
    let queryToken: string | null = null;
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      queryToken = url.searchParams.get("token");
    } catch {
      queryToken = null;
    }
    if (
      queryToken !== null &&
      queryToken !== "" &&
      credentialMatches(queryToken, launchToken, accessToken)
    ) {
      // Valid token: mint the cookie and redirect to a clean root URL so the
      // token does not survive in the address bar.
      return {
        ok: false,
        setCookie: cookieHeaderFor(Date.now()),
        redirectTo: "/",
      };
    }

    // 2. Cookie. Only a present, non-empty volto_auth is a credential.
    //    Unrelated cookies on the origin must not block the launch-token
    //    exchange. A presented-but-invalid volto_auth fails closed.
    const cookieHeader = getHeader(req, "cookie");
    if (cookieHeader !== undefined && cookieHeader !== "") {
      const value = extractCookieValue(cookieHeader, COOKIE_NAME);
      if (value !== null && value !== "") {
        if (verifyCookieValue(value)) {
          return { ok: true };
        }
        return { ok: false };
      }
      // Cookie header without volto_auth — fall through.
    }

    // 3. Authorization: Bearer <token>, where the token is either the
    //    per-process launch token or the persistent access token. Only a
    //    non-empty Bearer token is a credential; other schemes and empty
    //    tokens fall through.
    const authorization = getHeader(req, "authorization");
    if (authorization !== undefined) {
      const match = /^Bearer\s+(.*)$/i.exec(authorization);
      if (match) {
        const token = (match[1] ?? "").trim();
        if (token !== "" && credentialMatches(token, launchToken, accessToken)) {
          return { ok: true };
        }
        if (token !== "") {
          // Non-empty bearer that failed verification — fail closed.
          return { ok: false };
        }
        // Empty bearer token — fall through.
      }
      // Non-Bearer scheme (e.g. Basic) — fall through.
    }

    return { ok: false };
  }

  return {
    launchToken,
    accessToken,
    authenticatedUrl,
    authorize,
    cookieHeaderFor,
  };
}
