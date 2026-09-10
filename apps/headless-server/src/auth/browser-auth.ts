/**
 * Browser authentication for the headless gateway.
 *
 * A per-process launch token rides the root URL once and is exchanged for an
 * HMAC-signed HttpOnly cookie. Non-browser clients present the same token as
 * a bearer credential. Every failure path returns the same result so a caller
 * cannot tell why it was refused.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import * as path from "node:path";
import { ensureConfigDir, getConfigDir } from "../config/paths.js";

const SECRET_BYTES = 32;
const TOKEN_BYTES = 32;
const DEFAULT_MAX_AGE_DAYS = 7;
const COOKIE_NAME = "volto_auth";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
  /** Root URL carrying the launch token as its only auth input. */
  authenticatedUrl(baseUrl: string): string;
  /** Evaluate cookie → bearer → query token. Failures are indistinguishable. */
  authorize(req: IncomingMessage): AuthResult;
  /** Full Set-Cookie header value for a session minted at `now`. */
  cookieHeaderFor(now: number): string;
}

export interface CreateBrowserAuthOptions {
  /** Config directory holding `auth-secret`. Defaults to `getConfigDir()`. */
  dir?: string;
  /** Cookie lifetime in days. Default 7. */
  maxAgeDays?: number;
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

  // Fresh every process. A restart invalidates every previously issued URL;
  // that is intentional.
  const launchToken = crypto.randomBytes(TOKEN_BYTES).toString("base64url");

  function cookieValueFor(now: number): string {
    const exp = now + maxAgeMs;
    const payload = Buffer.from(JSON.stringify({ exp }), "utf-8").toString("base64url");
    return `${payload}.${signPayload(payload, secret)}`;
  }

  function cookieHeaderFor(now: number): string {
    const exp = now + maxAgeMs;
    const value = cookieValueFor(now);
    const expires = new Date(exp).toUTCString();
    return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}; Expires=${expires}`;
  }

  /** Verify signature first, then parse payload and check expiry. */
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

    let exp: unknown;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
      if (typeof parsed !== "object" || parsed === null) return false;
      exp = (parsed as { exp?: unknown }).exp;
    } catch {
      return false;
    }
    if (typeof exp !== "number" || !Number.isFinite(exp)) return false;
    return exp > Date.now();
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
    // 1. Cookie. Only a present, non-empty volto_auth is a credential.
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

    // 2. Authorization: Bearer <launchToken>. Only a non-empty Bearer token
    //    is a credential; other schemes and empty tokens fall through.
    const authorization = getHeader(req, "authorization");
    if (authorization !== undefined) {
      const match = /^Bearer\s+(.*)$/i.exec(authorization);
      if (match) {
        const token = (match[1] ?? "").trim();
        if (token !== "" && tokensMatch(token, launchToken)) {
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

    // 3. Query token. Valid token redirects to a clean root URL and sets the
    //    cookie so the token does not survive in the address bar.
    let queryToken: string | null = null;
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      queryToken = url.searchParams.get("token");
    } catch {
      queryToken = null;
    }
    if (queryToken !== null && queryToken !== "" && tokensMatch(queryToken, launchToken)) {
      return {
        ok: false,
        setCookie: cookieHeaderFor(Date.now()),
        redirectTo: "/",
      };
    }

    return { ok: false };
  }

  return {
    launchToken,
    authenticatedUrl,
    authorize,
    cookieHeaderFor,
  };
}
