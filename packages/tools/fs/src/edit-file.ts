import type { FileSystem } from "@agent-core/core";
import { z } from "zod";
import { CAP_FS_WRITE } from "./capabilities.js";
import { computeFuzzyMatchRegex } from "./fuzzy-match.js";
import { defineFileTool } from "./define-tool.js";
import type { FileTool } from "./common.js";

export { computeFuzzyMatchRegex } from "./fuzzy-match.js";

const schema = z.object({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

// Note: read-before-edit + staleness gating runs in the runtime tool executor
// (it needs the current on-disk mtime); this handler performs the replacement
// only after that gate has passed.
export function createEditFileTool(fs: FileSystem): FileTool {
  return defineFileTool({
    name: "edit_file",
    description: "Replace content using str_replace with optional fuzzy fallback. Requires a prior read_file of the same path.",
    schema,
    requires: [CAP_FS_WRITE],
    riskTier: "WRITE_LOW",
    run: async ({ path, old_string: oldString, new_string: newString, replace_all: replaceAll = false }) => {
      if (!oldString) {
        return { modelContent: `edit_file failed: old_string must not be empty.`, isError: true };
      }

      let content: string;
      try {
        content = (await fs.read(path)).content;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `edit_file failed to read ${path}: ${message}`, isError: true };
      }

      const occurrences = content.split(oldString).length - 1;
      let updated: string;
      let editMode: string;

      if (occurrences === 0) {
        // Fuzzy fallback: ignore per-line leading/trailing whitespace, then inter-token whitespace.
        const regex = computeFuzzyMatchRegex(content, oldString);
        const match = regex?.exec(content);
        if (!regex || !match) {
          return {
            modelContent: `edit_file failed: old_string not found in ${path}. Provide more surrounding context or verify the file contents.`,
            isError: true,
          };
        }
        updated = `${content.slice(0, match.index)}${newString}${content.slice(match.index + match[0].length)}`;
        editMode = "fuzzy";
      } else if (occurrences > 1 && !replaceAll) {
        return {
          modelContent: `edit_file failed: old_string matched ${occurrences} times in ${path}. Narrow the match or pass replace_all: true.`,
          isError: true,
        };
      } else {
        updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, () => newString);
        editMode = replaceAll ? "replaceAll" : "exact";
      }

      try {
        await fs.write(path, updated);
        const mtime = (await fs.stat(path)).mtime;
        return {
          modelContent: `edit_file: ${editMode} replacement applied in ${path}.`,
          displayMetadata: { path, editMode, writeFile: { path, mtime } },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `edit_file failed to write ${path}: ${message}`, isError: true };
      }
    },
  });
}
