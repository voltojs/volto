import type { FileSystem } from "@volto/core";
import { z } from "zod";
import { CAP_FS_WRITE } from "./capabilities.js";
import { computeFuzzyMatchRegex, findFuzzyMatch, preserveIndentation } from "./fuzzy-match.js";
import { defineTool as defineFileTool } from "@volto/tools-common";
import type { Tool as FileTool } from "@volto/tools-common";

export { computeFuzzyMatchRegex, findFuzzyMatch, preserveIndentation } from "./fuzzy-match.js";

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
    pathInputs: ["path"],
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
        if (!regex) {
          return {
            modelContent: `edit_file failed: old_string not found in ${path}. Provide more surrounding context or verify the file contents.`,
            isError: true,
          };
        }

        if (replaceAll) {
          // Replace all fuzzy matches — iterate and apply each one.
          let result = content;
          let replaced = 0;
          let match = findFuzzyMatch(result, regex);
          while (match) {
            const indentedNew = preserveIndentation(result, match.index, newString);
            result = result.slice(0, match.index) + indentedNew + result.slice(match.index + match[0].length);
            replaced++;
            // Reset regex for next iteration on the modified string.
            regex.lastIndex = match.index + indentedNew.length;
            match = findFuzzyMatch(result, regex);
          }
          if (replaced === 0) {
            return {
              modelContent: `edit_file failed: old_string not found in ${path}. Provide more surrounding context or verify the file contents.`,
              isError: true,
            };
          }
          updated = result;
          editMode = "fuzzy-replaceAll";
        } else {
          const match = findFuzzyMatch(content, regex);
          if (!match) {
            return {
              modelContent: `edit_file failed: old_string not found in ${path}. Provide more surrounding context or verify the file contents.`,
              isError: true,
            };
          }
          const indentedNew = preserveIndentation(content, match.index, newString);
          updated = `${content.slice(0, match.index)}${indentedNew}${content.slice(match.index + match[0].length)}`;
          editMode = "fuzzy";
        }
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
