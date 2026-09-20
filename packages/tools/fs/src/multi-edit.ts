import type { FileSystem } from "@volto/core";
import { z } from "zod";
import { CAP_FS_WRITE } from "./capabilities.js";
import { defineTool as defineFileTool } from "@volto/tools-common";
import type { Tool as FileTool } from "@volto/tools-common";

/**
 * Atomic multi-edit: apply multiple str_replace operations to a single file.
 * All replacements must succeed for any to be written (atomicity).
 * On any failure, the original file is untouched and the error is returned.
 */

const editEntrySchema = z.object({
  old_string: z.string().describe("Exact string to find and replace."),
  new_string: z.string().describe("Replacement string."),
  replace_all: z.boolean().optional().describe("Replace all occurrences (default: false, single match expected)."),
});

const schema = z.object({
  path: z.string().describe("File path to edit."),
  edits: z.array(editEntrySchema).min(1).max(20).describe("Ordered list of str_replace operations to apply atomically."),
});

interface EditEntry {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * Try applying all edits in sequence to the content.
 * Returns the final content on success, or an error on the first failure.
 * The original content is never modified.
 */
function tryApplyEdits(
  content: string,
  edits: EditEntry[],
): { content: string } | { error: string; editIndex: number } {
  let current = content;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    const { old_string: oldStr, new_string: newStr, replace_all: replaceAll } = edit;

    if (!oldStr) {
      return { error: `Edit ${i + 1}: old_string must not be empty.`, editIndex: i };
    }

    const occurrences = current.split(oldStr).length - 1;

    if (occurrences === 0) {
      return {
        error: `Edit ${i + 1}: old_string not found in file. Ensure the file content matches (consider that earlier edits in this batch may have changed it).`,
        editIndex: i,
      };
    }

    if (occurrences > 1 && !replaceAll) {
      return {
        error: `Edit ${i + 1}: old_string matched ${occurrences} times. Use replace_all: true or narrow the match.`,
        editIndex: i,
      };
    }

    current = replaceAll ? current.split(oldStr).join(newStr) : current.replace(oldStr, () => newStr);
  }

  return { content: current };
}

export function createMultiEditTool(fs: FileSystem): FileTool {
  return defineFileTool({
    name: "multi_edit",
    description: "Apply multiple str_replace operations to a single file atomically. All edits succeed or none are applied. Requires a prior read_file of the same path.",
    schema,
    requires: [CAP_FS_WRITE],
    riskTier: "WRITE_LOW",
    pathInputs: ["path"],
    run: async ({ path, edits }) => {
      // Read current content
      let originalContent: string;
      try {
        originalContent = (await fs.read(path)).content;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `multi_edit failed to read ${path}: ${message}`, isError: true };
      }

      // Try all edits (pure, no side effects)
      const result = tryApplyEdits(originalContent, edits);
      if ("error" in result) {
        return {
          modelContent: `multi_edit aborted: ${result.error} File unchanged.`,
          isError: true,
          displayMetadata: { path, failedEditIndex: result.editIndex },
        };
      }

      // All edits succeeded — write back
      try {
        await fs.write(path, result.content);
        const mtime = (await fs.stat(path)).mtime;
        return {
          modelContent: `multi_edit: ${edits.length} edit(s) applied atomically to ${path}.`,
          displayMetadata: { path, editsApplied: edits.length, writeFile: { path, mtime } },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `multi_edit failed to write ${path}: ${message}`, isError: true };
      }
    },
  });
}
