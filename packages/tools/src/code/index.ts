// @voltojs/tools-code — LSP code intelligence tools

export type { LspClient, LspClientProvider, LspDiagnostic, LspDiagnosticReport, LspDocumentReference, LspLocation, LspHover, LspReference } from "./lsp-client.js";
export { CAP_LSP_QUERY } from "./lsp-client.js";
export { fileToUri, uriToFile } from "./lsp-uri.js";
export {
  createLspDefinitionTool,
  createLspReferencesTool,
  createLspRenameTool,
  createLspDiagnosticsTool,
  createLspHoverTool,
  LSP_TOOL_NAMES,
  LSP_ERROR_CODES,
  LSP_ERROR_TEXT,
  formatLspError,
} from "./lsp-tools.js";
export type { LspToolErrorCode } from "./lsp-tools.js";
