import type { FileSystem, ToolDefinition } from "@agent-core/core";
import { CAP_FS_WRITE } from "./capabilities.js";
import type { FileTool } from "./common.js";

export function createWriteFileTool(fs: FileSystem): FileTool {
  const definition: ToolDefinition = {
    name: "write_file",
    description: "Create or overwrite a file. Overwrite requires prior read_file of the same path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    requires: [CAP_FS_WRITE],
    riskTier: "WRITE_HIGH",
  };

  return {
    definition,
    handler: async (input) => {
      const path = String(input.path ?? "");
      const content = String(input.content ?? "");

      try {
        await fs.write(path, content);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `write_file failed: ${message}`, isError: true };
      }

      return {
        modelContent: `write_file: ${path} written.`,
        displayMetadata: { path, writeFile: { path } },
      };
    },
  };
}
