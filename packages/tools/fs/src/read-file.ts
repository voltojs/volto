import type { AttachmentStore, FileReadResult, FileSystem } from "@volto/core";
import { z } from "zod";
import { CAP_FS_READ } from "./capabilities.js";
import { defineTool as defineFileTool, MAX_IMAGE_BASE64, imageDownscaleHint, parsePageSpec } from "@volto/tools-common";
import type { Tool as FileTool } from "@volto/tools-common";
import { formatNotebook } from "./notebook.js";

const MAX_LINES = 2000;
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const schema = z.object({
  path: z.string().describe("Absolute or workspace-relative path."),
  offset: z.number().int().positive().optional().describe("1-based start line."),
  limit: z.number().int().positive().optional().describe("Maximum lines to return."),
  pages: z
    .string()
    .optional()
    .describe(
      'PDF only: 1-based pages to return, e.g. "2" or "1,3-5". Omit to read the whole document.',
    ),
});

/**
 * Structural view of the document parser that read_file needs for `.pdf`.
 * Deliberately not `DocumentParserAdapter` from @volto/tools-document:
 * tools-fs must not depend on another tool package — the host (SDK) passes
 * the instance, and anything with a compatible `parse` works.
 */
export interface PdfLikeParser {
  parse(
    path: string,
    opts?: { pages?: number[] },
  ): Promise<{
    contentType: string;
    text?: string;
    mimeType?: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface ReadFileToolOptions {
  /** Required for the image path: images leave as AttachmentStore references. */
  attachments?: AttachmentStore;
  /**
   * Tri-state vision gate. `false` rejects image reads; absent/undefined
   * does not gate (hosts that have not wired capability yet keep working).
   */
  visionSupported?: boolean;
  /**
   * Parses `.pdf` files. Absent → `.pdf` is refused with isError instead of
   * falling through to the utf-8 text path (which produces mojibake).
   */
  documentParser?: PdfLikeParser;
}

export function createReadFileTool(fs: FileSystem, opts?: ReadFileToolOptions): FileTool {
  return defineFileTool({
    name: "read_file",
    description:
      "Read a file with line numbers (cat -n style). Supports offset and limit for pagination. " +
      "Images and Jupyter notebooks are read natively; PDFs are parsed (pass pages like \"2\" or \"1,3-5\" to read selected pages).",
    schema,
    requires: [CAP_FS_READ],
    riskTier: "READ_ONLY",
    pathInputs: ["path"],
    run: async ({ path, offset, limit, pages }) => {
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
      let selectedPages: number[] | undefined;
      if (ext === ".pdf") {
        // A .pdf must NEVER reach the utf-8 text path below: reading binary
        // as utf-8 yields mojibake the model would trust as content. With no
        // parser wired the honest answer is an error, not garbage.
        if (!opts?.documentParser) {
          return {
            modelContent: `read_file cannot parse "${path}": no document parser is wired. Use read_document instead.`,
            isError: true,
          };
        }
        if (pages !== undefined) {
          const parsedPages = parsePageSpec(pages);
          if (parsedPages === null) {
            return {
              modelContent:
                `Invalid pages spec "${pages}". ` +
                `Use 1-based pages and inclusive ranges, e.g. "2" or "1,3-5".`,
              isError: true,
            };
          }
          selectedPages = parsedPages;
        }
        try {
          // Boundary through the port BEFORE the parser: the default node
          // parser reads with raw fs, so stat() is what stops an absolute
          // path outside the workspace (same trick as read_document).
          const stat = await fs.stat(path);
          // The parser opens with raw fs and cannot resolve a
          // workspace-relative path — ask the port for the absolute form
          // (FileStat.path is root-relative, not usable here).
          const parserPath = fs.resolvePath ? await fs.resolvePath(path) : path;
          const parsed = await opts.documentParser.parse(
            parserPath,
            selectedPages !== undefined ? { pages: selectedPages } : undefined,
          );
          if (parsed.contentType !== "text" || parsed.text === undefined) {
            return {
              modelContent: `read_file failed: the parser returned no text for "${path}"`,
              isError: true,
            };
          }
          // Slice locally so the shared line-numbering render below — and
          // with it offset/limit — works for PDFs exactly as for text files.
          const allLines = parsed.text.split(/\r?\n/);
          const from = startLine - 1;
          const slice = allLines.slice(from, from + lineLimit);
          result = {
            content: slice.join("\n"),
            totalLines: allLines.length,
            truncated: from + slice.length < allLines.length,
          } as FileReadResult;
          mtime = stat.mtime;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { modelContent: `read_file failed: ${message}`, isError: true };
        }
      } else {
        try {
          result = await fs.read(path, startLine, lineLimit);
          mtime = (await fs.stat(path)).mtime;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { modelContent: `read_file failed: ${message}`, isError: true };
        }
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
          ...(selectedPages !== undefined ? { selectedPages } : {}),
          readFile: { path, mtime },
        },
      };
    },
  });
}
