import type { FileSystem } from "@agent-core/core";
import { z } from "zod";
import { CAP_FS_READ } from "./capabilities.js";
import { defineTool as defineFileTool } from "@agent-core/tools-common";
import type { Tool as FileTool } from "@agent-core/tools-common";

const schema = z.object({
  path: z.string().default("."),
});

export function createLsTool(fs: FileSystem): FileTool {
  return defineFileTool({
    name: "ls",
    description: "List directory entries.",
    schema,
    requires: [CAP_FS_READ],
    riskTier: "READ_ONLY",
    run: async ({ path }) => {
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
  });
}
