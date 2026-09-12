/**
 * Read-only project file browsing for the RightPane — directory listing,
 * filename search, and file payloads, all confined to a project root.
 * Every path entering this module passes resolveWithinRoot: relative only,
 * no escaping segments, and realpath-verified to stay inside the root
 * (a symlink pointing out is rejected, not followed).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export class PathOutsideProjectError extends Error {}
export class NotADirectoryError extends Error {}

/** Directory names never listed, searched, or descended into. */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out", "coverage",
  ".turbo", ".vercel", "__pycache__", ".venv", "target",
]);

export interface FsEntry {
  name: string;
  type: "dir" | "file";
  size: number;
}

function isInside(container: string, candidate: string): boolean {
  const rel = path.relative(container, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve `rel` inside `root` and prove it stays there. Two passes: the
 * lexical check rejects `..`-style escapes before touching the disk; the
 * realpath pass re-verifies containment for paths that exist, closing the
 * symlink escape. A missing target falls back to the lexically-checked path
 * — the caller's own stat turns that into its 404.
 */
export async function resolveWithinRoot(root: string, rel: string): Promise<string> {
  if (path.isAbsolute(rel)) {
    throw new PathOutsideProjectError(`Path must be relative: ${rel}`);
  }
  const resolved = path.resolve(root, rel);
  if (!isInside(path.resolve(root), resolved)) {
    throw new PathOutsideProjectError(`Path escapes the project root: ${rel}`);
  }
  const realRoot = await fs.realpath(root);
  let realTarget = resolved;
  try {
    realTarget = await fs.realpath(resolved);
  } catch {
    // ENOENT and friends: keep the lexically-checked path; callers surface
    // the miss themselves (fs.stat → ENOENT → 404).
    return resolved;
  }
  if (!isInside(realRoot, realTarget)) {
    throw new PathOutsideProjectError(`Path escapes the project root: ${rel}`);
  }
  return resolved;
}

export async function listDirectory(projectRoot: string, rel: string): Promise<FsEntry[]> {
  const dir = await resolveWithinRoot(projectRoot, rel);
  const st = await fs.stat(dir);
  if (!st.isDirectory()) throw new NotADirectoryError(`Not a directory: ${rel}`);
  const names = (await fs.readdir(dir)).filter((n) => !n.startsWith("."));
  const withStats = await Promise.all(
    names.map(async (name) => {
      try {
        const s = await fs.stat(path.join(dir, name));
        return { name, type: s.isDirectory() ? ("dir" as const) : ("file" as const), size: s.size };
      } catch {
        return null; // dangling symlink / race — just skip the entry
      }
    }),
  );
  return withStats
    .filter((e): e is FsEntry => e !== null && !IGNORED_DIRS.has(e.name))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}
