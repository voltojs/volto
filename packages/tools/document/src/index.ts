/**
 * @agent-core/tools-document — document format parsing tools.
 *
 * read_document uses a DocumentParserAdapter to convert PDF/docx/xlsx/image
 * files into structured text or image blocks. The adapter is pluggable;
 * when not provided, the tool is automatically excluded from the visible set.
 */

import { z } from "zod";
import { defineTool } from "@agent-core/tools-common";
import type { Tool } from "@agent-core/tools-common";

// ──────────────────────────────────────────────
// DocumentParserAdapter — abstract interface
// ──────────────────────────────────────────────

/** Result of parsing a document */
export interface DocumentParseResult {
  /** Content type: "text" for extractable text, "image" for binary image data */
  contentType: "text" | "image";
  /** Parsed text content (for text-type documents) */
  text?: string;
  /** MIME type of the original document */
  mimeType: string;
  /** Structured metadata (page count, dimensions, etc.) */
  metadata?: Record<string, unknown>;
}

/** DocumentParserAdapter — abstract interface for file format parsing */
export interface DocumentParserAdapter {
  /** Parse a file at the given path and return structured content */
  parse(filePath: string): Promise<DocumentParseResult>;
}

// ──────────────────────────────────────────────
// read_document tool
// ──────────────────────────────────────────────

const CAP_DOCUMENT = "document:parse";
const MAX_TEXT_LENGTH = 100_000;

const readDocumentSchema = z.object({
  path: z.string().describe("Absolute or relative path to the document file."),
});

/**
 * Create a read_document tool that parses PDF/docx/xlsx/image files.
 */
export function createReadDocumentTool(parser: DocumentParserAdapter): Tool {
  return defineTool({
    name: "read_document",
    description:
      "Read and parse a document file (PDF, DOCX, XLSX, or image). " +
      "Returns the text content or a description of the image. " +
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

        // Image content type
        return {
          modelContent: `[Image: ${result.mimeType}] Image file parsed. Path: ${filePath}`,
          displayMetadata: {
            filePath,
            mimeType: result.mimeType,
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
