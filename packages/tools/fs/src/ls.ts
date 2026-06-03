import type { FileSystem, ToolDefinition } from "@agent-core/core";
import { CAP_FS_READ } from "./capabilities.js";
import type { FileTool } from "./common.js";

export function createLsTool(fs: FileSystem): FileTool {
  const definition: ToolDefinition = {
    name: "ls",
    description: "List directory entries.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
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
      const path = String(input.path ?? ".");
      try {
        const result = await fs.list(path);
        const lines = result.entries.map((entry) => `${entry.isDirectory ? "d" : "-"} ${entry.path}`);
        return {
          modelContent: lines.join("\n") || "(empty)",
          displayMetadata: { entryCount: result.entries.length },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `ls failed: ${message}`, isError: true };
      }
    },
  };
}
