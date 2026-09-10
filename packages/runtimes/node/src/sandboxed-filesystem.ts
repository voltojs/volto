/**
 * FileSystem sandbox decorator — the file-side counterpart of
 * `createSandboxedShell`.
 *
 * `createNodeFileSystem` already confines every operation to its construction
 * root with a lexical check. That is not enough for a sandbox mode: it has no
 * notion of read-only, it cannot see through a symlink that points out of the
 * workspace, and it does not protect `.git` / `.env` inside an otherwise
 * writable tree. This decorator adds exactly those three things — plus, when
 * `deniedReadPaths` is set, a read-side fence over named credential
 * directories.
 *
 * `write` is intercepted unconditionally. Read-side operations (`read` /
 * `stat` / `list` / `glob` / `grep`) pass through by default — a sandbox
 * bounds what may be *changed*, while what may be *seen* is the capability
 * gate's job — EXCEPT when they target a path under `deniedReadPaths`, which
 * is the one class of read the sandbox itself must refuse: those directories
 * hold the gateway's own authentication material.
 *
 * ## Architectural limitation: check-then-act (TOCTOU)
 *
 * `assertWritable` realpaths the write target and compares it against the
 * configured writable roots, and only then hands the path to the inner
 * filesystem to write. Between that check and the actual write, a symlink on
 * the path could be retargeted, redirecting the write somewhere the check
 * never saw. Closing the window would require writing through an already
 * verified handle rather than a path re-resolved at write time — a change
 * this decorator does not attempt. `createSandboxedShell` is designed the
 * same way (its boundary check and the shell process it spawns are also two
 * separate steps), so the limitation is shared across both sandboxed
 * adapters. In the agent scenarios this sandbox serves, the residual risk is
 * low: racing the check already implies control over the very workspace the
 * sandbox is protecting.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { FileSystem, SandboxMode } from "@volto/core";
import type { SandboxConfig } from "./sandbox.js";

/**
 * A write the sandbox refused. Thrown, not returned: the fs tool layer
 * normalizes it into an `isError: true` ToolResult, which is what reaches
 * the model — the agent loop is never interrupted by it.
 */
export class SandboxBoundaryError extends Error {
  constructor(
    readonly path: string,
    readonly mode: SandboxMode,
    message: string,
  ) {
    super(message);
    this.name = "SandboxBoundaryError";
  }
}

/**
 * Maximum number of symlinks dereferenced while resolving one path, mirroring
 * the OS's own ELOOP ceiling. Guards against a symlink cycle spinning the
 * walk below forever.
 */
const MAX_SYMLINK_HOPS = 40;

/**
 * Resolve a path's real location, tolerating a target that does not exist
 * yet.
 *
 * `fsp.realpath` cannot be used directly: it rejects as soon as ANY
 * component of the path is missing — including a symlink's own target. A
 * naive "catch and walk up to the nearest existing ancestor, then
 * re-lexically-append the tail" fallback (the previous approach here) gets
 * this wrong for a *dangling* symlink: the symlink component itself exists,
 * only its target doesn't, so walking up treats the symlink as "missing"
 * and re-appends its own name under its parent — resolving it to its own
 * lexical location instead of following it. That silently turns a symlink
 * escape into an "allowed" write.
 *
 * Instead this walks the path one component at a time, exactly like a
 * realpath implementation: for each component, `lstat` it; if it is a
 * symlink, `readlink` it (which succeeds even when the link's target does
 * not exist) and splice the target's components in to be resolved next,
 * restarting from the filesystem root so any symlinks nested inside the
 * target are also followed. A component that does not exist at all (ENOENT
 * or any other lstat failure) stops symlink-following for that component and
 * everything after it — the remaining tail is appended lexically, so a
 * not-yet-created file under an otherwise-real directory still resolves
 * predictably.
 *
 * This uniformly covers: a dangling symlink as the final component, a
 * symlinked ancestor several segments up (whether or not *its* target
 * exists), and a chain of symlinks — every hop is dereferenced via
 * `readlink`, not assumed away.
 */
async function realResolve(target: string): Promise<string> {
  const absolute = path.resolve(target);
  const queue = absolute.split(path.sep).filter(Boolean);
  let resolved = path.parse(absolute).root;
  let hops = 0;

  while (queue.length > 0) {
    const segment = queue.shift()!;
    const candidate = path.join(resolved, segment);

    let stat: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      stat = await fsp.lstat(candidate);
    } catch {
      // Doesn't exist (or can't be inspected): nothing left to dereference.
      // Keep it — and everything still queued — as a lexical path.
      resolved = candidate;
      continue;
    }

    if (!stat.isSymbolicLink()) {
      resolved = candidate;
      continue;
    }

    hops++;
    if (hops > MAX_SYMLINK_HOPS) {
      throw new Error(`Too many levels of symbolic links resolving "${target}"`);
    }

    const linkTarget = await fsp.readlink(candidate);
    const combined = path.isAbsolute(linkTarget) ? linkTarget : path.join(resolved, linkTarget);
    // Restart from the root with the link target's components spliced in
    // front of whatever was still queued, so a symlink nested inside the
    // target (or the target itself being relative) is resolved correctly
    // too.
    resolved = path.parse(combined).root;
    queue.unshift(...combined.split(path.sep).filter(Boolean));
  }

  return resolved;
}

/**
 * Resolve a configured writable root the same way `realResolve` resolves a
 * write target (following symlinks), so both sides of the boundary
 * comparison are expressed in the same terms. `os.tmpdir()` is itself a
 * symlink on macOS, and `SandboxConfig.writableRoots` documents that as part
 * of its default — a purely lexical `path.resolve` on the root while the
 * target goes through `realpath` would reject every legal write under it.
 *
 * A root that does not exist on disk yet is tolerated: it resolves to its
 * lexical form (via `realResolve`'s existing ancestor-walk fallback) rather
 * than throwing, so a misconfigured-but-not-yet-created root simply fails to
 * match anything instead of crashing the decorator at construction time.
 */
async function realResolveRoot(root: string): Promise<string> {
  return realResolve(root);
}

/** Whether `target` is `root` itself or lives underneath it. */
function isWithin(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function createSandboxedFileSystem(
  fs: FileSystem,
  config: SandboxConfig,
  /**
   * The root the inner `fs` resolves relative paths against — i.e. what it
   * was constructed with (`createNodeFileSystem({ root })`). Required and
   * explicit rather than inferred: the boundary check and the actual write
   * must resolve the same relative target against the same root, or the
   * check examines a path that is never written while the path that is
   * written is never checked. A future caller passing the wrong root here
   * silently reopens that hole, so this is spelled out rather than
   * defaulted.
   */
  options: { root: string },
): FileSystem {
  // No restriction to add — hand back the original rather than paying for a
  // wrapper on every call.
  if (config.mode === "danger-full-access") return fs;

  const mode = config.mode;
  const innerRoot = path.resolve(options.root);
  const rawWritableRoots = (config.writableRoots ?? [process.cwd()]).map((root) =>
    path.resolve(root),
  );
  const readOnlyOverlays = config.readOnlyOverlays ?? [".git", ".env"];
  const rawDeniedReadPaths = (config.deniedReadPaths ?? []).map((p) => path.resolve(p));

  // Real (symlink-resolved) writable roots are computed lazily and cached:
  // createSandboxedFileSystem must stay synchronous (callers construct it
  // inline), so the async realpath work happens on first use inside
  // assertWritable rather than at construction time.
  let realWritableRootsPromise: Promise<string[]> | undefined;
  function getRealWritableRoots(): Promise<string[]> {
    if (!realWritableRootsPromise) {
      realWritableRootsPromise = Promise.all(rawWritableRoots.map(realResolveRoot));
    }
    return realWritableRootsPromise;
  }

  // Same lazy-resolve discipline as the writable roots above — denied read
  // paths must be compared in real-path terms or the check silently misses
  // on macOS's symlinked /tmp and /var.
  let realDeniedReadPathsPromise: Promise<string[]> | undefined;
  function getRealDeniedReadPaths(): Promise<string[]> {
    if (!realDeniedReadPathsPromise) {
      realDeniedReadPathsPromise = Promise.all(rawDeniedReadPaths.map(realResolveRoot));
    }
    return realDeniedReadPathsPromise;
  }

  /** Resolve a target the same way the boundary checks do (absolute + real). */
  function toCandidate(target: string): string {
    return path.isAbsolute(target) ? target : path.join(innerRoot, target);
  }

  /**
   * Whether `target` (a path or a path-shaped string from a result list)
   * lands under any denied read path. Returns the matching denied root, or
   * undefined.
   */
  async function findDeniedRoot(target: string): Promise<string | undefined> {
    const denied = await getRealDeniedReadPaths();
    if (denied.length === 0) return undefined;
    const resolved = await realResolve(toCandidate(target));
    return denied.find((d) => isWithin(resolved, d));
  }

  async function assertReadable(target: string): Promise<void> {
    const hit = await findDeniedRoot(target);
    if (hit !== undefined) {
      throw new SandboxBoundaryError(
        target,
        mode,
        `Cannot read "${target}": it is inside a denied credential directory. ` +
          `This is not a restriction you can work around — ask the user if you need the contents.`,
      );
    }
  }

  async function assertWritable(target: string): Promise<void> {
    if (mode === "read-only") {
      throw new SandboxBoundaryError(
        target,
        mode,
        `Cannot write "${target}": the sandbox is in read-only mode. ` +
          `Report what you would change instead, or ask the user to switch to a writable permission tier.`,
      );
    }

    const resolved = await realResolve(target);
    const writableRoots = await getRealWritableRoots();

    const root = writableRoots.find((candidate) => isWithin(resolved, candidate));
    if (root === undefined) {
      throw new SandboxBoundaryError(
        target,
        mode,
        `Cannot write "${target}": it resolves to "${resolved}", outside the writable workspace ` +
          `(${writableRoots.join(", ")}). Work inside the workspace, or ask the user to switch to full access.`,
      );
    }

    const relative = path.relative(root, resolved);
    const segments = relative.split(path.sep);
    const overlay = readOnlyOverlays.find((entry) => {
      const entrySegments = entry.split(path.sep);
      return entrySegments.length === 1
        ? // Single-segment entry (e.g. ".git"): matches that segment at any
          // depth, preserving the pre-existing "caught wherever it appears"
          // behaviour without falsely matching a substring like
          // "myfile.gitignore" (segments.includes is exact, not substring).
          segments.includes(entry)
        : // Multi-segment entry (e.g. "secrets/prod.env"): matches as a path
          // prefix relative to the writable root.
          relative === entry || relative.startsWith(entry + path.sep);
    });
    if (overlay !== undefined) {
      throw new SandboxBoundaryError(
        target,
        mode,
        `Cannot write "${target}": "${overlay}" stays read-only even inside the writable workspace. ` +
          `Use a dedicated tool for it, or ask the user to make the change.`,
      );
    }
  }

  return {
    ...fs,
    async write(target: string, data: string): Promise<void> {
      // The inner FileSystem resolves relative paths against innerRoot (the
      // root it was constructed with), so the boundary check must resolve
      // them the same way before comparing — otherwise the checked path and
      // the written path can diverge.
      const candidate = path.isAbsolute(target) ? target : path.join(innerRoot, target);
      await assertWritable(candidate);
      await fs.write(target, data);
    },
    async read(target: string, offset?: number, limit?: number) {
      await assertReadable(target);
      return fs.read(target, offset, limit);
    },
    async stat(target: string) {
      await assertReadable(target);
      return fs.stat(target);
    },
    async list(dir: string) {
      await assertReadable(dir);
      return fs.list(dir);
    },
    async glob(pattern: string) {
      const result = await fs.glob(pattern);
      if (rawDeniedReadPaths.length === 0) return result;
      const kept: string[] = [];
      for (const p of result.paths) {
        if ((await findDeniedRoot(p)) === undefined) kept.push(p);
      }
      return { paths: kept };
    },
    async grep(query: string, opts?: { path?: string; glob?: string; limit?: number }) {
      if (opts?.path !== undefined) {
        await assertReadable(opts.path);
      }
      const result = await fs.grep(query, opts);
      if (rawDeniedReadPaths.length === 0) return result;
      const kept: typeof result.matches = [];
      for (const m of result.matches) {
        if ((await findDeniedRoot(m.path)) === undefined) kept.push(m);
      }
      return { ...result, matches: kept };
    },
  };
}
