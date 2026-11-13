import type { FileWatcher } from "@voltojs/core";
import { z } from "zod";
import { CAP_FS_WATCH } from "./capabilities.js";
import { defineTool as defineFileTool } from "@voltojs/tools-common";
import type { Tool as FileTool } from "@voltojs/tools-common";

const schema = z.object({
  watch_id: z.string(),
});

export function createUnwatchFilesTool(watcher: FileWatcher): FileTool {
  return defineFileTool({
    name: "unwatch_files",
    description: "Stop a file watch previously registered with watch_files. Unknown ids report cancelled=false.",
    schema,
    requires: [CAP_FS_WATCH],
    riskTier: "READ_ONLY",
    run: async ({ watch_id }) => {
      try {
        const cancelled = await watcher.unwatch(watch_id);
        return {
          modelContent: `unwatch_files: watch_id=${watch_id} cancelled=${String(cancelled)}`,
          displayMetadata: { watchId: watch_id, cancelled },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `unwatch_files failed: ${message}`, isError: true };
      }
    },
  });
}
