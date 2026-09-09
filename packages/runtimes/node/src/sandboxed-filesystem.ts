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

/** Whether `target` is `root` itself or lives underneath it. */
function isWithin(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function createSandboxedFileSystem(
  fs: FileSystem,
  config: SandboxConfig,
): FileSystem {
  // No restriction to add — hand back the original rather than paying for a
  // wrapper on every call.
  if (config.mode === "danger-full-access") return fs;

  const mode = config.mode;
  const writableRoots = (config.writableRoots ?? [process.cwd()]).map((root) =>
    path.resolve(root),
  );
  const readOnlyOverlays = config.readOnlyOverlays ?? [".git", ".env"];

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
    const overlay = readOnlyOverlays.find((entry) => segments.includes(entry));
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
      // The inner FileSystem resolves relative paths against its own root, so
      // the boundary check must resolve them the same way before comparing.
      const candidate = path.isAbsolute(target)
        ? target
        : path.join(writableRoots[0] ?? process.cwd(), target);
      await assertWritable(candidate);
      await fs.write(target, data);
    },
  };
}
