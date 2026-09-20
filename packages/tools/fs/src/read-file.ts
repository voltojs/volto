import type { AttachmentStore, FileReadResult, FileSystem } from "@volto/core";
import { z } from "zod";
import { CAP_FS_READ } from "./capabilities.js";
import { defineTool as defineFileTool, MAX_IMAGE_BASE64, imageDownscaleHint } from "@volto/tools-common";
import type { Tool as FileTool } from "@volto/tools-common";
import { formatNotebook } from "./notebook.js";

const MAX_LINES = 2000;
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const schema = z.object({
  path: z.string().describe("Absolute or workspace-relative path."),
  offset: z.number().int().positive().optional().describe("1-based start line."),
  limit: z.number().int().positive().optional().describe("Maximum lines to return."),
});

export interface ReadFileToolOptions {
  /** Required for the image path: images leave as AttachmentStore references. */
  attachments?: AttachmentStore;
  /**
   * Tri-state vision gate. `false` rejects image reads; absent/undefined
   * does not gate (hosts that have not wired capability yet keep working).
   */
  visionSupported?: boolean;
}

export function createReadFileTool(fs: FileSystem, opts?: ReadFileToolOptions): FileTool {
  return defineFileTool({
    name: "read_file",
    description: "Read a file with line numbers (cat -n style). Supports offset and limit for pagination.",
    schema,
    requires: [CAP_FS_READ],
    riskTier: "READ_ONLY",
    pathInputs: ["path"],
    run: async ({ path, offset, limit }) => {
      const ext = path.slice(path.lastIndexOf(".")).toLowerCase();

      if (IMAGE_EXTS.has(ext)) {
        if (!opts?.attachments) {
          return {
            modelContent: "read_file cannot return images: no attachment store is configured.",
            isError: true,
          };
        }
        // Deliberately no "use tool X instead": with no vision support there is
        // no other path that works either.
        if (opts.visionSupported === false) {
          return { modelContent: "The current model does not support image input.", isError: true };
        }
        try {
          const bytes = await fs.readBytes(path);
          if (bytes.data.length > MAX_IMAGE_BASE64) {
            return { modelContent: `Image is too large to send (${bytes.size} bytes).`, isError: true };
          }
          const stored = await opts.attachments.put(bytes.data, bytes.mimeType ?? "image/png");
          const hint = imageDownscaleHint(stored.width, stored.height);
          return {
            modelContent: [
              { type: "text", text: hint ? `Image ${path}\n${hint}` : `Image ${path}` },
              {
                type: "image",
                source: { type: "ref", id: stored.id, mediaType: stored.mimeType },
                ...(stored.width !== undefined ? { width: stored.width } : {}),
                ...(stored.height !== undefined ? { height: stored.height } : {}),
              },
            ],
            displayMetadata: { filePath: path, mimeType: stored.mimeType },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { modelContent: `read_file failed: ${message}`, isError: true };
        }
      }

      if (ext === ".ipynb") {
        try {
          const file = await fs.read(path);
          return {
            modelContent: formatNotebook(file.content),
            displayMetadata: { filePath: path, notebook: true },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { modelContent: `read_file failed: ${message}`, isError: true };
        }
      }

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
