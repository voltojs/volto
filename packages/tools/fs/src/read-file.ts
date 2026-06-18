import type { FileReadResult, FileSystem } from "@volto/core";
import { z } from "zod";
import { CAP_FS_READ } from "./capabilities.js";
import { defineTool as defineFileTool } from "@volto/tools-common";
import type { Tool as FileTool } from "@volto/tools-common";

const MAX_LINES = 2000;

const schema = z.object({
  path: z.string().describe("Absolute or workspace-relative path."),
  offset: z.number().int().positive().optional().describe("1-based start line."),
  limit: z.number().int().positive().optional().describe("Maximum lines to return."),
});

export function createReadFileTool(fs: FileSystem): FileTool {
  return defineFileTool({
    name: "read_file",
    description: "Read a file with line numbers (cat -n style). Supports offset and limit for pagination.",
    schema,
    requires: [CAP_FS_READ],
    riskTier: "READ_ONLY",
    run: async ({ path, offset, limit }) => {
      const startLine = offset ?? 1;
      const lineLimit = Math.min(limit ?? MAX_LINES, MAX_LINES);

      let result: FileReadResult;
      let mtime: number;
      try {
        result = await fs.read(path, startLine, lineLimit);
        mtime = (await fs.stat(path)).mtime;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `read_file failed: ${message}`, isError: true };
      }

      const lines = result.content.split(/\r?\n/);
      const numbered = lines.map((line, index) => `${startLine + index}\t${line}`).join("\n");
      const prefix = result.truncated ? `read_file: output truncated at ${lineLimit} lines.\n` : "";

      return {
        modelContent: `${prefix}${numbered}`,
        displayMetadata: {
          totalLines: result.totalLines,
          truncated: result.truncated,
          offset: startLine,
          limit: lineLimit,
          readFile: { path, mtime },
        },
      };
    },
  });
}
