/**
 * @agent-core/tools-document — document format parsing tools.
 *
 * read_document uses a DocumentParserAdapter to convert PDF/docx/xlsx/image
 * files into structured text or image blocks. The adapter is pluggable;
 * when not provided, the tool is automatically excluded from the visible set.
 */

export type { DocumentParserAdapter, DocumentParseResult } from "./document-parser.js";
export { createReadDocumentTool, DOCUMENT_TOOL_NAMES } from "./read-document.js";
