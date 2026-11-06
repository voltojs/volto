import type { FileSystem } from "@volto/core";
import { z } from "zod";
import { CAP_FS_WRITE } from "./capabilities.js";
import { computeUnifiedDiff, defineTool as defineFileTool } from "@volto/tools-common";
import type { Tool as FileTool } from "@volto/tools-common";

/**
 * Unified diff hunk — a contiguous block of context/+/− lines
 * representing a single change within a file.
 */
interface DiffHunk {
  /** 1-based line number in the original file where the hunk starts */
  originalStart: number;
  /** Number of context + deleted lines in the hunk */
  originalLines: string[];
  /** Replacement lines (context + added) that should replace the matched region */
  replacementLines: string[];
}

/**
 * Parse a unified diff string into hunks.
 * Expects standard unified diff format:
 *   @@ -oldStart,oldCount +newStart,newCount @@
 *   context line
 *  -deleted line
 *  +added line
 */
function parseUnifiedDiff(diff: string): DiffHunk[] {
  const lines = diff.split("\n");
  const hunks: DiffHunk[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Find hunk header: @@ -start,count +start,count @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      const originalStart = parseInt(hunkMatch[1]!, 10);
      const originalLines: string[] = [];
      const replacementLines: string[] = [];
      i++;

      while (i < lines.length) {
        const hunkLine = lines[i]!;
        if (hunkLine.startsWith("@@") || hunkLine.startsWith("diff --git") || hunkLine.startsWith("---") || hunkLine.startsWith("+++")) {
          break;
        }

        if (hunkLine.startsWith("-")) {
          originalLines.push(hunkLine.slice(1));
        } else if (hunkLine.startsWith("+")) {
          replacementLines.push(hunkLine.slice(1));
        } else if (hunkLine.startsWith(" ")) {
          // Context line — present in both original and replacement
          originalLines.push(hunkLine.slice(1));
          replacementLines.push(hunkLine.slice(1));
        } else if (hunkLine === "") {
          // Empty line — could be a blank context line
          originalLines.push("");
          replacementLines.push("");
        }
        i++;
      }

      hunks.push({ originalStart, originalLines, replacementLines });
    } else {
      i++;
    }
  }

  return hunks;
}

/**
 * Apply parsed hunks to file content.
 * For each hunk, search for the originalLines sequence (with ±2 line tolerance)
 * and replace with replacementLines.
 * Returns { content } on success or { error } with the failing hunk index.
 */
function applyHunks(
  fileLines: string[],
  hunks: DiffHunk[],
): { content: string } | { error: string; hunkIndex: number; candidates: number[] } {
  // Work on a copy; hunks are applied sequentially (each shifts line numbers)
  let lines = [...fileLines];

  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h]!;
    const searchStart = Math.max(0, hunk.originalStart - 1); // convert to 0-based

    // Exact match search
    let matchIdx = -1;
    for (let offset = 0; offset <= 4; offset++) {
      const candidate = searchStart + offset;
      if (candidate + hunk.originalLines.length > lines.length) break;
      const slice = lines.slice(candidate, candidate + hunk.originalLines.length);
      if (slice.every((line, idx) => line === hunk.originalLines[idx])) {
        matchIdx = candidate;
        break;
      }
    }

    if (matchIdx < 0) {
      // Collect candidate positions for error message
      const candidates: number[] = [];
      for (let offset = -2; offset <= 4; offset++) {
        const pos = searchStart + offset;
        if (pos >= 0 && pos + hunk.originalLines.length <= lines.length) {
          candidates.push(pos + 1); // 1-based for display
        }
      }
      return {
        error: `Hunk ${h + 1} did not match at line ${hunk.originalStart}. File content may have changed.`,
        hunkIndex: h,
        candidates,
      };
    }

    // Apply: replace matched region with replacementLines
    lines = [
      ...lines.slice(0, matchIdx),
      ...hunk.replacementLines,
      ...lines.slice(matchIdx + hunk.originalLines.length),
    ];
  }

  return { content: lines.join("\n") };
}

const schema = z.object({
  path: z.string().describe("File path to apply the patch to."),
  patch: z.string().describe("Unified diff patch to apply."),
});

export function createApplyPatchTool(fs: FileSystem): FileTool {
  return defineFileTool({
    name: "apply_patch",
    description: "Apply a unified diff patch to a file. Requires a prior read_file of the same path. Returns an error with candidate line positions if hunks don't match.",
    schema,
    requires: [CAP_FS_WRITE],
    riskTier: "WRITE_LOW",
    pathInputs: ["path"],
    run: async ({ path, patch }) => {
      // Parse the diff
      const hunks = parseUnifiedDiff(patch);
      if (hunks.length === 0) {
        return { modelContent: `apply_patch: no hunks found in the provided patch.`, isError: true };
      }

      // Read current file content
      let fileContent: string;
      try {
        fileContent = (await fs.read(path)).content;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `apply_patch failed to read ${path}: ${message}`, isError: true };
      }

      const fileLines = fileContent.split("\n");

      // Apply hunks
      const result = applyHunks(fileLines, hunks);
      if ("error" in result) {
        return {
          modelContent: `${result.error} Try re-reading the file for fresh content, or adjust the hunk context.`,
          isError: true,
          displayMetadata: { path, hunkIndex: result.hunkIndex, candidates: result.candidates },
        };
      }

      // Write back
      try {
        await fs.write(path, result.content);
        const mtime = (await fs.stat(path)).mtime;
        return {
          modelContent: `apply_patch: ${hunks.length} hunk(s) applied to ${path}.`,
          displayMetadata: {
            path,
            hunksApplied: hunks.length,
            writeFile: { path, mtime },
            fileChange: { path, ...computeUnifiedDiff(fileContent, result.content) },
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `apply_patch failed to write ${path}: ${message}`, isError: true };
      }
    },
  });
}
