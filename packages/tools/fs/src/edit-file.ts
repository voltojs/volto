import type { FileSystem, ToolDefinition } from "@agent-core/core";
import { CAP_FS_WRITE } from "./capabilities.js";
import { computeFuzzyMatchRegex } from "./fuzzy-match.js";
import type { FileTool } from "./common.js";

export { computeFuzzyMatchRegex } from "./fuzzy-match.js";

export function createEditFileTool(fs: FileSystem): FileTool {
  const definition: ToolDefinition = {
    name: "edit_file",
    description: "Replace content using str_replace with optional fuzzy fallback. Requires prior read_file of the same path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    requires: [CAP_FS_WRITE],
    riskTier: "WRITE_LOW",
  };

  return {
    definition,
    handler: async (input) => {
      const path = String(input.path ?? "");
      const oldString = String(input.old_string ?? "");
      const newString = String(input.new_string ?? "");
      const replaceAll = input.replace_all === true;

      if (!oldString) {
        return { modelContent: `edit_file failed: old_string must not be empty.`, isError: true };
      }

      let content: string;
      try {
        const file = await fs.read(path);
        content = file.content;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `edit_file failed to read ${path}: ${message}`, isError: true };
      }

      const occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) {
        const regex = computeFuzzyMatchRegex(content, oldString);
        if (!regex) {
          return {
            modelContent: `edit_file failed: old_string not found in ${path}. Provide more surrounding context or verify the file contents.`,
            isError: true,
          };
        }

        const match = regex.exec(content);
        if (!match) {
          return {
            modelContent: `edit_file failed: fuzzy match candidate expired before replacement in ${path}.`,
            isError: true,
          };
        }

        const updated = `${content.slice(0, match.index)}${newString}${content.slice(match.index + match[0].length)}`;
        await fs.write(path, updated);
        return {
          modelContent: `edit_file: fuzzy replacement applied in ${path}.`,
          displayMetadata: { path, editMode: "fuzzy", writeFile: { path } },
        };
      }

      if (occurrences > 1 && !replaceAll) {
        return {
          modelContent: `edit_file failed: old_string matched ${occurrences} times in ${path}. Narrow the match or pass replace_all: true.`,
          isError: true,
        };
      }

      const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, () => newString);
      await fs.write(path, updated);
      return {
        modelContent: `edit_file: replacement applied in ${path}.`,
        displayMetadata: { path, editMode: replaceAll ? "replaceAll" : "exact", writeFile: { path } },
      };
    },
  };
}
