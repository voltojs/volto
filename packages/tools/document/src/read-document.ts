/**
 * read_document — document parsing tool wrapping DocumentParserAdapter.
 */

import type { AttachmentStore, FileSystem } from "@volto/core";
import { z } from "zod";
import { defineTool, MAX_IMAGE_BASE64, imageDownscaleHint, parsePageSpec } from "@volto/tools-common";
import type { Tool } from "@volto/tools-common";
import type { DocumentParserAdapter } from "./document-parser.js";

const CAP_DOCUMENT = "document:parse";
const MAX_TEXT_LENGTH = 100_000;

const readDocumentSchema = z.object({
  path: z.string().describe("Absolute or relative path to the document file."),
  pages: z
    .string()
    .optional()
    .describe(
      "1-based pages to return for paginated formats (PDF), e.g. \"2\" or \"1,3-5\". " +
        "Omit to read the whole document.",
    ),
});

export interface ReadDocumentToolOptions {
  /** Required for the image path: images leave as AttachmentStore references. */
  attachments?: AttachmentStore;
  /**
   * Tri-state vision gate. `false` rejects image reads; absent/undefined
   * does not gate (hosts that have not wired capability yet keep working).
   */
  visionSupported?: boolean;
  /**
   * Workspace boundary. When provided, the path is checked against this
   * FileSystem port before the parser runs. The default node parser uses
   * raw `fs`, so without this a model could read_document an absolute path
   * outside the workspace that read_file would refuse. Hosts that bring
   * their own documentParser and intentionally parse outside the workspace
   * omit this option.
   */
  fs?: FileSystem;
}

/**
 * Create a read_document tool that parses PDF/docx/xlsx/image files.
 */
export function createReadDocumentTool(
  parser: DocumentParserAdapter,
  opts?: ReadDocumentToolOptions,
): Tool {
  return defineTool({
    name: "read_document",
    description:
      "Read and parse a document file (PDF, DOCX, XLSX, or image). " +
      "Returns the text content, or the image itself when the model supports vision. " +
      "For long PDFs pass `pages` (e.g. \"2\" or \"1,3-5\") to read selected pages instead of the whole document. " +
      "Use this instead of read_file for non-code document files.",
    schema: readDocumentSchema,
    requires: [CAP_DOCUMENT],
    riskTier: "READ_ONLY",
    // A document's `path` is a filesystem path too: the Runner resolves it the
    // same way it resolves read_file's, so path rules apply here as well.
    pathInputs: ["path"],
    run: async ({ path: filePath, pages }) => {
      try {
        let selectedPages: number[] | undefined;
        if (pages !== undefined) {
          const parsed = parsePageSpec(pages);
          if (parsed === null) {
            return {
              modelContent:
                `Invalid pages spec "${pages}". ` +
                `Use 1-based pages and inclusive ranges, e.g. "2" or "1,3-5".`,
              isError: true,
            };
          }
          selectedPages = parsed;
        }
        // Force the same workspace-boundary check read_file uses. stat() is
        // the cheapest FileSystem method that routes through the port's
        // path resolver; an escape throws the denial before the parser (raw
        // fs) ever sees the path.
        if (opts?.fs) {
          await opts.fs.stat(filePath);
        }
        // The parser opens with raw fs: hand it the ABSOLUTE path the port
        // resolves (FileStat.path is root-relative; a workspace-relative
        // model path would be opened against the gateway's cwd → ENOENT).
        const parserPath =
          opts?.fs?.resolvePath ? await opts.fs.resolvePath(filePath) : filePath;
        const result = await parser.parse(
          parserPath,
          selectedPages !== undefined ? { pages: selectedPages } : undefined,
        );

        if (result.contentType === "text") {
          let text = result.text ?? "";
          let truncated = false;
          if (text.length > MAX_TEXT_LENGTH) {
            text = text.slice(0, MAX_TEXT_LENGTH) + "\n... [truncated]";
            truncated = true;
          }

          return {
            modelContent: `[${result.mimeType}] ${text}`,
            displayMetadata: {
              filePath,
              mimeType: result.mimeType,
              contentType: "text",
              textLength: (result.text ?? "").length,
              truncated,
              ...(selectedPages !== undefined ? { selectedPages } : {}),
              ...result.metadata,
            },
          };
        }

        // Image content type — leave as an AttachmentStore reference.
        if (!opts?.attachments) {
          return {
            modelContent: "read_document cannot return images: no attachment store is configured.",
            isError: true,
          };
        }
        // Deliberately no "use tool X instead": with no vision support there is
        // no other path that works either.
        if (opts.visionSupported === false) {
          return { modelContent: "The current model does not support image input.", isError: true };
        }
        if (!result.data) {
          return {
            modelContent: `read_document failed for "${filePath}": parser returned no image bytes`,
            isError: true,
          };
        }
        // Same Global Constraint as read_file: never forward a >5 MB base64 image.
        if (result.data.length > MAX_IMAGE_BASE64) {
          return {
            modelContent: `Image is too large to send (${result.data.length} bytes).`,
            isError: true,
          };
        }

        const stored = await opts.attachments.put(result.data, result.mimeType);
        const hint = imageDownscaleHint(stored.width, stored.height);
        return {
          modelContent: [
            { type: "text", text: hint ? `Image ${filePath}\n${hint}` : `Image ${filePath}` },
            {
              type: "image",
              source: { type: "ref", id: stored.id, mediaType: stored.mimeType },
              ...(stored.width !== undefined ? { width: stored.width } : {}),
              ...(stored.height !== undefined ? { height: stored.height } : {}),
            },
          ],
          displayMetadata: {
            filePath,
            mimeType: stored.mimeType,
            contentType: "image",
            ...result.metadata,
          },
        };
      } catch (err) {
        return {
          modelContent: `read_document failed for "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  });
}

/** Tool names for this package */
export const DOCUMENT_TOOL_NAMES: ReadonlySet<string> = new Set(["read_document"]);
