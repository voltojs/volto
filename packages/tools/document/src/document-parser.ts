/**
 * DocumentParserAdapter — abstract interface for file format parsing.
 */

/** Result of parsing a document */
export interface DocumentParseResult {
  /** Content type: "text" for extractable text, "image" for binary image data */
  contentType: "text" | "image";
  /** Parsed text content (for text-type documents) */
  text?: string;
  /** Base64-encoded image bytes. Required when contentType is "image". */
  data?: string;
  /** MIME type of the original document */
  mimeType: string;
  /** Pixel width read from the image header, when recognized */
  width?: number;
  /** Pixel height read from the image header, when recognized */
  height?: number;
  /** Structured metadata (page count, file size, etc.) */
  metadata?: Record<string, unknown>;
}

/** Options controlling how a document is parsed. */
export interface DocumentParseOptions {
  /**
   * 1-based page numbers to return. Honored by paginated formats (PDF);
   * formats without pages (docx/xlsx/plain text) ignore it — the tool layer
   * decides whether that is acceptable for the format in play.
   */
  pages?: number[];
}

/** DocumentParserAdapter — abstract interface for file format parsing */
export interface DocumentParserAdapter {
  /** Parse a file at the given path and return structured content */
  parse(filePath: string, opts?: DocumentParseOptions): Promise<DocumentParseResult>;
}
