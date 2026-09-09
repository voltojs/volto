/**
 * FileSystem sandbox decorator — the file-side counterpart of
 * `createSandboxedShell`.
 *
 * `createNodeFileSystem` already confines every operation to its construction
 * root with a lexical check. That is not enough for a sandbox mode: it has no
 * notion of read-only, it cannot see through a symlink that points out of the
 * workspace, and it does not protect `.git` / `.env` inside an otherwise
 * writable tree. This decorator adds exactly those three things.
 *
 * Only `write` is intercepted. Read-side operations pass through: a sandbox
 * bounds what may be *changed*, while what may be *seen* is the capability
 * gate's job.
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
 * Resolve a path's real location, tolerating a target that does not exist
 * yet: walk up to the nearest existing ancestor, resolve that (following
 * symlinks), then re-append the missing tail. A purely lexical resolve would
 * miss a symlinked ancestor pointing out of the workspace.
 *
 * When no ancestor exists at all (rare — e.g. the whole path is bogus), the
 * lexically-resolved absolute path is returned unchanged so callers still
 * get a deterministic value to compare against.
 */
async function realResolve(target: string): Promise<string> {
  const absolute = path.resolve(target);
  const missing: string[] = [];
  let current = absolute;

  for (;;) {
    try {
      const real = await fsp.realpath(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
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
  };
}
