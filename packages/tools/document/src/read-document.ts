/**
 * read_document — document parsing tool wrapping DocumentParserAdapter.
 */

import type { AttachmentStore } from "@volto/core";
import { z } from "zod";
import { defineTool } from "@volto/tools-common";
import type { Tool } from "@volto/tools-common";
import type { DocumentParserAdapter } from "./document-parser.js";

const CAP_DOCUMENT = "document:parse";
const MAX_TEXT_LENGTH = 100_000;

const readDocumentSchema = z.object({
  path: z.string().describe("Absolute or relative path to the document file."),
});

export interface ReadDocumentToolOptions {
  /** Required for the image path: images leave as AttachmentStore references. */
  attachments?: AttachmentStore;
  /**
   * Tri-state vision gate. `false` rejects image reads; absent/undefined
   * does not gate (hosts that have not wired capability yet keep working).
   */
  visionSupported?: boolean;
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
      "Use this instead of read_file for non-code document files.",
    schema: readDocumentSchema,
    requires: [CAP_DOCUMENT],
    riskTier: "READ_ONLY",
    run: async ({ path: filePath }) => {
      try {
        const result = await parser.parse(filePath);

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

        const stored = await opts.attachments.put(result.data, result.mimeType);
        return {
          modelContent: [
            { type: "text", text: `Image ${filePath}` },
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
