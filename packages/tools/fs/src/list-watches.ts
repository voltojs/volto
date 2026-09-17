import type { FileWatcher } from "@volto/core";
import { z } from "zod";
import { CAP_FS_WATCH } from "./capabilities.js";
import { defineTool as defineFileTool } from "@volto/tools-common";
import type { Tool as FileTool } from "@volto/tools-common";

const schema = z.object({});

export function createListWatchesTool(watcher: FileWatcher): FileTool {
  return defineFileTool({
    name: "list_watches",
    description: "List active file watch ids registered with watch_files.",
    schema,
    requires: [CAP_FS_WATCH],
    riskTier: "READ_ONLY",
    run: async () => {
      try {
        const ids = await watcher.list();
        return {
          modelContent: ids.length > 0 ? ids.join("\n") : "(none)",
          displayMetadata: { watchIds: ids },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `list_watches failed: ${message}`, isError: true };
      }
    },
  });
}
