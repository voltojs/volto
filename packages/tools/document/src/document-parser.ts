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

/** DocumentParserAdapter — abstract interface for file format parsing */
export interface DocumentParserAdapter {
  /** Parse a file at the given path and return structured content */
  parse(filePath: string): Promise<DocumentParseResult>;
}
