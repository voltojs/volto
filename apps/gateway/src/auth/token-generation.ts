/**
 * The token generation a running gateway verifies cookies against.
 *
 * `volto token --rotate` has to invalidate every cookie already issued, and
 * it has to do so while the gateway keeps running — a rotation that only
 * takes effect after a restart is a security control you cannot count on.
 * So the generation is re-read at request time instead of being frozen when
 * the server starts.
 *
 * Reading the file on every request would be wasteful, so the value is cached
 * keyed on the file's `stat` identity (`mtimeMs` + size + inode). `stat` is
 * one syscall on a local file; the token itself is only re-read when that
 * identity changes. Any failure to stat or read fails CLOSED: the caller
 * gets `null`, never the last known generation, because a cache that
 * survives a deleted token file would keep honouring cookies the operator
 * just revoked.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ACCESS_TOKEN_FILE, parseAccessToken } from "./access-token.js";

export interface TokenGeneration {
  /** Current access token. */
  readonly token: string;
  /** Generation identifier carried in cookie payloads. */
  readonly version: string;
}

/** The fingerprint function to use; injected so this module stays generic. */
export type Fingerprint = (token: string) => string;

/**
 * Cache key: `mtimeMs` + size + inode. All three must match for a hit, so an
 * in-place rewrite that somehow preserved the timestamp but changed the size
 * (or replaced the file via rename) still forces a re-read.
 */
function identityOf(stat: { mtimeMs: number; size: number; ino: number }): string {
  return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
}

/**
 * A reader for `<dir>/access-token`. Create it once per auth instance; call
 * `read()` whenever the current generation is needed.
 */
export function createTokenGenerationReader(dir: string, fingerprint: Fingerprint) {
  const file = path.join(dir, ACCESS_TOKEN_FILE);
  let cached: { identity: string; generation: TokenGeneration } | null = null;

  return {
    /** Current generation, or `null` when it cannot be read (fail closed). */
    async read(): Promise<TokenGeneration | null> {
      let identity: string;
      try {
        identity = identityOf(await fs.stat(file));
      } catch {
        // Deleted or unreadable: drop the cache so a later `volto token`
        // cannot be served from a stale entry.
        cached = null;
        return null;
      }
      if (cached !== null && cached.identity === identity) return cached.generation;

      let token: string | null;
      try {
        token = parseAccessToken(await fs.readFile(file, "utf-8"));
      } catch {
        cached = null;
        return null;
      }
      if (token === null) {
        cached = null;
        return null;
      }
      const generation: TokenGeneration = { token, version: fingerprint(token) };
      cached = { identity, generation };
      return generation;
    },
  };
}