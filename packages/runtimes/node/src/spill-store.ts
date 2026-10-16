import fs from "node:fs/promises";
import path from "node:path";
import type { SpillStore } from "@volto/core";

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

export function createNodeSpillStore(opts: NodeSpillStoreOptions): SpillStore {
  return {
    async write(input) {
      assertSegment("sessionId", input.sessionId);
      assertSegment("toolCallId", input.toolCallId);
      const dir = path.join(opts.rootDir, ".volto", "spill", input.sessionId);
      const filePath = path.join(dir, input.toolCallId + ".txt");
      await fs.mkdir(dir, { recursive: true });
      // Plain overwrite: writing the same ids again replaces the file, so
      // repeat writes for one tool call are idempotent by construction.
      await fs.writeFile(filePath, input.text, "utf8");
      return { relativePath: `.volto/spill/${input.sessionId}/${input.toolCallId}.txt` };
    },
  };
}
