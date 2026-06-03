import type { FileSystem, ToolDefinition } from "@agent-core/core";
import { CAP_FS_READ } from "./capabilities.js";
import type { FileTool } from "./common.js";

export function createGlobTool(fs: FileSystem): FileTool {
  const definition: ToolDefinition = {
    name: "glob",
    description: "Find files by glob pattern, sorted by modification time.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    requires: [CAP_FS_READ],
    riskTier: "READ_ONLY",
  };

  return {
    definition,
    handler: async (input) => {
      const pattern = String(input.pattern ?? "");
      try {
        const result = await fs.glob(pattern);
        return {
          modelContent: result.paths.join("\n") || "(no matches)",
          displayMetadata: { matchCount: result.paths.length },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `glob failed: ${message}`, isError: true };
      }
    },
  };
}
