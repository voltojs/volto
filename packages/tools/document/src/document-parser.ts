/**
 * DocumentParserAdapter — abstract interface for file format parsing.
 */

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
