import type { FileSystem } from "@agent-core/core";
import { z } from "zod";
import { CAP_FS_READ } from "./capabilities.js";
import { defineFileTool } from "./define-tool.js";
import type { FileTool } from "./common.js";

const schema = z.object({
  pattern: z.string(),
});

export function createGlobTool(fs: FileSystem): FileTool {
  return defineFileTool({
    name: "glob",
    description: "Find files by glob pattern, sorted by modification time (newest first).",
    schema,
    requires: [CAP_FS_READ],
    riskTier: "READ_ONLY",
    run: async ({ pattern }) => {
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
  });
}
