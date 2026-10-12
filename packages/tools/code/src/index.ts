// @volto/tools-code — LSP code intelligence tools

export type { LspClient, LspClientProvider, LspLocation, LspDiagnostic, LspHover, LspReference } from "./lsp-client.js";
export { CAP_LSP_QUERY } from "./lsp-client.js";
export { fileToUri, uriToFile } from "./lsp-uri.js";
export {
  createLspDefinitionTool,
  createLspReferencesTool,
  createLspRenameTool,
  createLspDiagnosticsTool,
  createLspHoverTool,
  LSP_TOOL_NAMES,
} from "./lsp-tools.js";
