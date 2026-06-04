import type { FileSystem } from "@agent-core/core";
import { z } from "zod";
import { CAP_FS_READ } from "./capabilities.js";
import { defineTool as defineFileTool } from "@agent-core/tools-common";
import type { Tool as FileTool } from "@agent-core/tools-common";

const DEFAULT_LIMIT = 200;

const schema = z.object({
  query: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export function createGrepTool(fs: FileSystem): FileTool {
  return defineFileTool({
    name: "grep",
    description: "Search file contents (ripgrep) with optional path/glob filters. Results are truncated when large.",
    schema,
    requires: [CAP_FS_READ],
    riskTier: "READ_ONLY",
    run: async ({ query, path, glob, limit }) => {
      const effectiveLimit = limit ?? DEFAULT_LIMIT;
      try {
        const result = await fs.grep(query, { path, glob, limit: effectiveLimit });
        const matches = result.matches.map((match) => `${match.path}:${match.line}: ${match.text}`);
        const truncatedSuffix = result.truncated ? `\n(truncated at ${effectiveLimit} matches)` : "";
        return {
          modelContent: `${matches.join("\n") || "(no matches)"}${truncatedSuffix}`,
          displayMetadata: { matchCount: result.matches.length, truncated: result.truncated },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `grep failed: ${message}`, isError: true };
      }
    },
  });
}
