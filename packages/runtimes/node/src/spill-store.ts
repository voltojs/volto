import fs from "node:fs/promises";
import path from "node:path";
import type { SpillStore } from "@voltojs/core";

export interface NodeSpillStoreOptions {
  /** Workspace root — the same root the FileSystem port was built with. */
  rootDir: string;
}

/**
 * A storage path segment is a single, non-empty name; separators or `..`
 * are escapes. Mirrors the attachment-store guard: `path.join(root, "")`
 * resolves to root itself, so an empty segment would escape the spill dir.
 */
function isValidSegment(segment: string): boolean {
  if (segment.trim() === "") return false;
  if (segment === "." || segment === "..") return false;
  return !segment.includes("/") && !segment.includes("\\") && !segment.includes("..");
}

function assertSegment(field: "sessionId" | "toolCallId", value: string): void {
  if (!isValidSegment(value)) {
    throw new Error(
      `Invalid spill ${field}: ${JSON.stringify(value)} — must be a non-empty path segment`,
    );
  }
}

/** Whether `target` is `root` itself or a path underneath it. */
function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function createNodeSpillStore(opts: NodeSpillStoreOptions): SpillStore {
  return {
    async write(input) {
      assertSegment("sessionId", input.sessionId);
      assertSegment("toolCallId", input.toolCallId);
      const spillRoot = path.join(opts.rootDir, ".volto", "spill");
      // Creating the root itself is safe: a fixed literal path under rootDir.
      // Its realpath is the canonical base every containment check compares
      // against (the workspace may sit behind a symlinked ancestor, e.g.
      // os.tmpdir() on macOS).
      await fs.mkdir(spillRoot, { recursive: true });
      const realRoot = await fs.realpath(spillRoot);

      // mkdir first, realpath second: realpath of a not-yet-created directory
      // throws ENOENT. The spill root lives in the model-writable workspace,
      // so the session dir may be a pre-planted symlink pointing outside it —
      // resolving it here turns a would-be write-through-the-link into a
      // rejection before anything is written.
      const sessionDir = path.join(spillRoot, input.sessionId);
      await fs.mkdir(sessionDir, { recursive: true });
      const realSessionDir = await fs.realpath(sessionDir);
      if (!isWithin(realRoot, realSessionDir)) {
        throw new Error(
          `Spill session dir ${JSON.stringify(input.sessionId)} escapes the spill root: ${realSessionDir}`,
        );
      }

      const filePath = path.join(sessionDir, input.toolCallId + ".txt");
      // writeFile follows a symlink at the target name — including a dangling
      // one, which would create the file at its (possibly outside) target.
      // The name is volto's own path namespace inside the verified session
      // dir, so replace any symlink with a fresh regular file instead of
      // writing through it.
      const existing = await fs.lstat(filePath).catch(() => undefined);
      if (existing?.isSymbolicLink()) {
        await fs.unlink(filePath);
      }
      // Plain overwrite: writing the same ids again replaces the file, so
      // repeat writes for one tool call are idempotent by construction.
      await fs.writeFile(filePath, input.text, "utf8");
      return { relativePath: `.volto/spill/${input.sessionId}/${input.toolCallId}.txt` };
    },
  };
}
