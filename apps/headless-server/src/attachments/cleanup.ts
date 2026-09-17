/**
 * Best-effort reclaim of attachment directories that no live session owns.
 *
 * A grace period is load-bearing: a user who has picked an image but not yet
 * sent the message owns a directory no session references, and reaping it
 * immediately would break the upload they are in the middle of.
 */

import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";

/** Default grace period before an unreferenced session dir is reclaimed. */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CleanupOrphanOptions {
  /** Attachment store root — one subdirectory per session id. */
  rootDir: string;
  /** Injected clock, so tests do not depend on wall time. */
  now: number;
  /** Orphan age threshold. Defaults to 24h. */
  maxAgeMs?: number;
  /** Session ids that still exist; their attachments are never removed. */
  liveSessionIds: Set<string>;
}

export interface CleanupOrphanResult {
  /** Session directory names that were removed. */
  removed: string[];
}

/**
 * Remove attachment directories that belong to no live session and have not
 * been touched within `maxAgeMs`.
 *
 * Only DIRECT subdirectories of `rootDir` are considered, and each candidate
 * is joined as `path.join(rootDir, entry.name)` where `entry.name` comes from
 * readdir — never from request input. Files sitting loose in the root are
 * left alone.
 */
export async function cleanupOrphanAttachments(
  opts: CleanupOrphanOptions,
): Promise<CleanupOrphanResult> {
  const { rootDir, now, liveSessionIds } = opts;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const removed: string[] = [];

  let entries: Dirent[];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    // Missing or unreadable root: nothing to reclaim.
    return { removed };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (liveSessionIds.has(entry.name)) continue;

    const dir = path.join(rootDir, entry.name);
    let ageMs: number;
    try {
      const stat = await fs.stat(dir);
      ageMs = now - stat.mtimeMs;
    } catch {
      // Raced with an external removal — treat as already gone.
      continue;
    }
    if (ageMs <= maxAgeMs) continue;

    try {
      await fs.rm(dir, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // Best-effort: a locked or already-vanished dir is not a startup failure.
    }
  }

  return { removed };
}
