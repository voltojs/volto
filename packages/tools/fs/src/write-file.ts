import type { FileSystem } from "@volto/core";
import { z } from "zod";
import { CAP_FS_WRITE } from "./capabilities.js";
import { defineTool as defineFileTool } from "@volto/tools-common";
import type { Tool as FileTool } from "@volto/tools-common";

const schema = z.object({
  path: z.string(),
  content: z.string(),
});

// Note: overwrite-requires-prior-read gating runs in the runtime tool executor
// (it needs to know whether the file already exists on disk).
export function createWriteFileTool(fs: FileSystem): FileTool {
  return defineFileTool({
    name: "write_file",
    description: "Create or overwrite a file. Overwriting an existing file requires a prior read_file of the same path.",
    schema,
    requires: [CAP_FS_WRITE],
    riskTier: "WRITE_HIGH",
    pathInputs: ["path"],
    run: async ({ path, content }) => {
      try {
        await fs.write(path, content);
        const mtime = (await fs.stat(path)).mtime;
        return {
          modelContent: `write_file: ${path} written.`,
          displayMetadata: { path, writeFile: { path, mtime } },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `write_file failed: ${message}`, isError: true };
      }
    },
  });
}
