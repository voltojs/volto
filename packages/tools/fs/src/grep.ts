import type { FileSystem, ToolDefinition } from "@agent-core/core";
import { CAP_FS_READ } from "./capabilities.js";
import type { FileTool } from "./common.js";

const DEFAULT_LIMIT = 200;

export function createGrepTool(fs: FileSystem): FileTool {
  const definition: ToolDefinition = {
    name: "grep",
    description: "Search file contents with optional path/glob filters. Results are truncated when large.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    requires: [CAP_FS_READ],
    riskTier: "READ_ONLY",
  };

  return {
    definition,
    handler: async (input) => {
      const query = String(input.query ?? "");
      const limit = typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : DEFAULT_LIMIT;

      try {
        const result = await fs.grep(query, {
          path: typeof input.path === "string" ? input.path : undefined,
          glob: typeof input.glob === "string" ? input.glob : undefined,
          limit,
        });

        const matches = result.matches.map((match) => `${match.path}:${match.line}: ${match.text}`);
        const truncatedSuffix = result.truncated ? `\n(truncated at ${limit} matches)` : "";
        return {
          modelContent: `${matches.join("\n") || "(no matches)"}${truncatedSuffix}`,
          displayMetadata: { matchCount: result.matches.length, truncated: result.truncated },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `grep failed: ${message}`, isError: true };
      }
    },
  };
}
