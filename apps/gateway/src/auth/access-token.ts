/**
 * The persistent access token.
 *
 * One token per config directory, stored as `access-token` (0600). Unlike the
 * per-process launch token in `browser-auth.ts`, this one survives restarts so
 * a remote client can be handed a stable credential; `volto token --rotate`
 * is the only way to change it.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureConfigDir } from "../config/paths.js";

/** Raw entropy per token — 32 bytes render as 43 base64url characters. */
const TOKEN_BYTES = 32;
/** base64url alphabet, fixed-length — anything else is a corrupted file. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const TOKEN_FILE = "access-token";

function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

function tokenPath(dir: string): string {
  return path.join(dir, TOKEN_FILE);
}

/** Fresh token with a leading newline tolerance removed — files are written with one. */
function normalize(raw: string): string {
  const trimmed = raw.trim();
  return TOKEN_PATTERN.test(trimmed) ? trimmed : "";
}

async function writeToken(dir: string, token: string): Promise<void> {
  await ensureConfigDir(dir);
  const file = tokenPath(dir);
  // `wx` fails when the file already exists, so a concurrent creator wins and
  // its token — not this one — is the survivor; the caller re-reads below.
  try {
    await fs.writeFile(file, `${token}\n`, { mode: 0o600, flag: "wx" });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // Rotation path: replace in place. `writeFile` keeps the mode of an existing
  // file, so chmod afterwards covers a file whose permissions were loosened.
  await fs.writeFile(file, `${token}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

/**
 * Read the token for `dir`, creating it on first use. A file whose contents do
 * not decode to a 43-character base64url token is treated as corrupt and
 * rewritten rather than handed to a caller that would then fail to match it.
 */
export async function loadOrCreateAccessToken(dir: string): Promise<string> {
  const file = tokenPath(dir);
  let raw: string | null = null;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (raw !== null) {
    const existing = normalize(raw);
    if (existing !== "") {
      // A pre-existing file may predate this code path; keep the 0600 promise.
      await fs.chmod(file, 0o600).catch(() => undefined);
      return existing;
    }
  }

  const generated = generateToken();
  try {
    await writeToken(dir, generated);
  } catch (err) {
    // A concurrent writer won the race and wrote its own token: read that one.
    const raced = normalize(await fs.readFile(file, "utf-8").catch(() => ""));
    if (raced !== "") return raced;
    throw err;
  }

  // Report what is actually on disk, so two racing callers agree.
  const stored = normalize(await fs.readFile(file, "utf-8").catch(() => ""));
  return stored !== "" ? stored : generated;
}

/** Replace the token with a fresh one. Returns the new value. */
export async function rotateAccessToken(dir: string): Promise<string> {
  const token = generateToken();
  await writeToken(dir, token);
  return token;
}

/**
 * Stable, non-reversible identifier for a token — 16 hex characters (first 8
 * bytes of SHA-256). Cookies carry this instead of the token so rotating the
 * file invalidates every cookie issued before the rotation.
 */
export function tokenFingerprint(token: string): string {
  return crypto.createHash("sha256").update(token, "utf-8").digest("hex").slice(0, 16);
}