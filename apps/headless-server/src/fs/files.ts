/**
 * Read-only project file browsing for the RightPane — directory listing,
 * filename search, and file payloads, all confined to a project root.
 * Every path entering this module passes resolveWithinRoot: relative only,
 * no escaping segments, and realpath-verified to stay inside the root
 * (a symlink pointing out is rejected, not followed).
 */

import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
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

export class FileTooLargeError extends Error {}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const BINARY_SNIFF_BYTES = 8192;

const IMAGE_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".bmp": "image/bmp", ".avif": "image/avif",
};

export type FsFileData =
  | { kind: "text"; content: string; truncated: boolean; size: number }
  | { kind: "image"; base64: string; mediaType: string; size: number }
  | { kind: "binary"; size: number };

/** BFS the project (ignored/hidden dirs pruned), capped on hits and visits. */
export async function searchFiles(
  projectRoot: string,
  query: string,
  cap = 200,
): Promise<string[]> {
  const needle = query.toLowerCase();
  const root = await fs.realpath(projectRoot);
  const matches: string[] = [];
  let visited = 0;
  const queue: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: root, rel: "", depth: 0 },
  ];
  while (queue.length > 0 && matches.length < cap && visited < 2000) {
    const { abs, rel, depth } = queue.shift()!;
    let names: string[];
    try {
      names = await fs.readdir(abs);
    } catch {
      continue;
    }
    for (const name of names) {
      if (visited >= 2000 || matches.length >= cap) break;
      visited++;
      if (name.startsWith(".") || IGNORED_DIRS.has(name)) continue;
      const childRel = rel === "" ? name : `${rel}/${name}`;
      let st: Stats;
      try {
        st = await fs.stat(path.join(abs, name));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 16) queue.push({ abs: path.join(abs, name), rel: childRel, depth: depth + 1 });
      } else if (name.toLowerCase().includes(needle)) {
        matches.push(childRel);
      }
    }
  }
  return matches;
}

export async function readFilePayload(projectRoot: string, rel: string): Promise<FsFileData> {
  const abs = await resolveWithinRoot(projectRoot, rel);
  const st = await fs.stat(abs);
  if (st.isDirectory()) throw new NotADirectoryError(`Not a file: ${rel}`);
  const mime = IMAGE_MIME[path.extname(rel).toLowerCase()];
  if (mime !== undefined) {
    if (st.size > MAX_IMAGE_BYTES) {
      throw new FileTooLargeError(`Image too large to preview (${st.size} bytes)`);
    }
    const buf = await fs.readFile(abs);
    return { kind: "image", base64: buf.toString("base64"), mediaType: mime, size: st.size };
  }
  // Read at most MAX_TEXT_BYTES even for huge files — open + read bounds the
  // buffer instead of slurping then slicing.
  const cap = Math.min(st.size, MAX_TEXT_BYTES);
  const buf = Buffer.alloc(cap);
  const handle = await fs.open(abs, "r");
  try {
    await handle.read(buf, 0, cap, 0);
  } finally {
    await handle.close();
  }
  // A NUL byte in the prefix is the cheapest reliable binary sniff — UTF-8
  // text never contains one.
  if (buf.subarray(0, Math.min(cap, BINARY_SNIFF_BYTES)).includes(0)) {
    return { kind: "binary", size: st.size };
  }
  return {
    kind: "text",
    content: buf.toString("utf8"),
    truncated: st.size > MAX_TEXT_BYTES,
    size: st.size,
  };
}
