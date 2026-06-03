import type { FileReadResult, FileSystem, ToolDefinition } from "@agent-core/core";
import { CAP_FS_READ } from "./capabilities.js";
import type { FileTool } from "./common.js";

const MAX_LINES = 2000;

export function createReadFileTool(fs: FileSystem): FileTool {
  const definition: ToolDefinition = {
    name: "read_file",
    description: "Read a file with line numbers (cat -n style). Supports offset and limit for pagination.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or workspace-relative path." },
        offset: { type: "number", description: "1-based start line." },
        limit: { type: "number", description: "Maximum lines to return." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    requires: [CAP_FS_READ],
    riskTier: "READ_ONLY",
  };

  return {
    definition,
    handler: async (input) => {
      const path = String(input.path ?? "");
      const offset = typeof input.offset === "number" && input.offset > 0 ? Math.floor(input.offset) : 1;
      const limit = typeof input.limit === "number" && input.limit > 0 ? Math.min(Math.floor(input.limit), MAX_LINES) : MAX_LINES;

      let result: FileReadResult;
      try {
        result = await fs.read(path, offset, limit);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `read_file failed: ${message}`, isError: true };
      }

      const lines = result.content.split(/\r?\n/);
      const numbered = lines.map((line, index) => `${offset + index}\t${line}`).join("\n");

      if (result.truncated) {
        const message = `read_file: output truncated at ${limit} lines.`;
        return {
          modelContent: `${message}\n${numbered}`,
          displayMetadata: {
            totalLines: result.totalLines,
            truncated: true,
            offset,
            limit,
            readFile: { path },
          },
        };
      }

      return {
        modelContent: numbered,
        displayMetadata: {
          totalLines: result.totalLines,
          truncated: false,
          offset,
          limit,
          readFile: { path },
        },
      };
    },
  };
}
