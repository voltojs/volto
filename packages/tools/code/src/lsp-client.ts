/**
 * LspClient — interface for an LSP language server adapter.
 * Implementations handle the I/O (stdio to language server process).
 * The core imports this interface, never its implementation.
 */

/** A source location (file + line/column) */
export interface LspLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/** A diagnostic (error/warning/info) from the language server */
export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  source?: string;
}

/** Hover information (markdown content at a position) */
export interface LspHover {
  contents: string;
}

/**
 * Diagnostics for one document, plus where they came from.
 *
 * `source` exists because an empty `diagnostics` array is ambiguous: a server
 * that reported "no problems" (`"push"`, or `"pull"` with no items) is a
 * different fact from a server that has not reported anything yet (`"none"`).
 * Rendering both as "no diagnostics" hides a server that is still indexing
 * behind a clean bill of health.
 *
 * - `"pull"` — asked and answered via `textDocument/diagnostic` (an empty
 *   answer is still an answer).
 * - `"push"` — taken from the server's `textDocument/publishDiagnostics`
 *   cache (an empty array means "reported and clean").
 * - `"none"` — nothing has been reported for this document.
 */
export interface LspDiagnosticReport {
  diagnostics: LspDiagnostic[];
  source: "pull" | "push" | "none";
}

/** Reference to a symbol */
export interface LspReference {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/**
 * A reference to a document, in either spelling a caller may have:
 *
 * - a `file:` URI (`file:///repo/src/a.ts`), or
 * - a filesystem path, absolute (`/repo/src/a.ts`) or relative to the workspace
 *   root (`src/a.ts`).
 *
 * The implementation owns document identity — it resolves the reference
 * through the same workspace boundary as `LspClientProvider.forFile`, derives
 * the canonical URI, and syncs that document before the request. Callers that
 * only hold a path (the `lsp_*` tools, which cannot compute a workspace root)
 * can therefore pass one through unchanged.
 */
export type LspDocumentReference = string;

export interface LspClient {
  /** Get definition location(s) for a symbol at a document reference and position */
  definition(document: LspDocumentReference, line: number, character: number): Promise<LspLocation[]>;
  /** Find all references to a symbol at a document reference and position */
  references(document: LspDocumentReference, line: number, character: number): Promise<LspReference[]>;
  /** Rename a symbol at a document reference and position */
  rename(document: LspDocumentReference, line: number, character: number, newName: string): Promise<Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } } }>>>;
  /** Get diagnostics for a document, saying whether they were pulled, pushed or absent */
  diagnostics(document: LspDocumentReference): Promise<LspDiagnosticReport>;
  /** Get hover information at a document reference and position */
  hover(document: LspDocumentReference, line: number, character: number): Promise<LspHover | null>;
}

/**
 * The tool-side consumption surface: the only thing the `lsp_*` tools need
 * from a language server. The runtime owns the process lifetime, document
 * sync and path containment; the tools never see any of it.
 *
 * Declared here — next to `LspClient` and away from any implementation — so
 * `tools-code` stays free of imports from `runtimes-*` (which would be a
 * dependency cycle: `runtime-node` already depends on `tools-code`).
 */
export interface LspClientProvider {
  /** A client able to answer for `file` (workspace-relative or absolute). */
  forFile(file: string): Promise<LspClient>;
}

export const CAP_LSP_QUERY = "lsp:query";
