import type { FileWatcher } from "@volto/core";
import { z } from "zod";
import { CAP_FS_WATCH } from "./capabilities.js";
import { defineTool as defineFileTool } from "@volto/tools-common";
import type { Tool as FileTool } from "@volto/tools-common";

const schema = z.object({
  paths: z.string().array().min(1),
  glob: z.string().optional(),
  debounce_ms: z.number().min(50).max(5000).optional(),
});

export function createWatchFilesTool(watcher: FileWatcher): FileTool {
  return defineFileTool({
    name: "watch_files",
    description:
      "Start watching workspace files or directories for changes. Returns a watch_id. " +
      "Debounced change batches are delivered by the host as file_changed inputs; " +
      "this tool only registers the watch.",
    schema,
    requires: [CAP_FS_WATCH],
    riskTier: "READ_ONLY",
    run: async ({ paths, glob, debounce_ms }) => {
      try {
        const debounceMs = debounce_ms ?? 200;
        // Event wiring (onEvents → file_changed input) is owned by the SDK;
        // the tool only registers and returns the id.
        const watchId = await watcher.watch({ paths, glob, debounceMs }, () => {});
        return {
          modelContent: `watch_files: watch_id=${watchId}, watching ${paths.length} path(s).`,
          displayMetadata: { watchId, paths, glob, debounceMs },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { modelContent: `watch_files failed: ${message}`, isError: true };
      }
    },
  });
}
