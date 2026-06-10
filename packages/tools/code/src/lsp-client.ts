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

/** Reference to a symbol */
export interface LspReference {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface LspClient {
  /** Get definition location(s) for a symbol at a position */
  definition(uri: string, line: number, character: number): Promise<LspLocation[]>;
  /** Find all references to a symbol at a position */
  references(uri: string, line: number, character: number): Promise<LspReference[]>;
  /** Rename a symbol at a position */
  rename(uri: string, line: number, character: number, newName: string): Promise<Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } } }>>>;
  /** Get diagnostics for a file */
  diagnostics(uri: string): Promise<LspDiagnostic[]>;
  /** Get hover information at a position */
  hover(uri: string, line: number, character: number): Promise<LspHover | null>;
}

export const CAP_LSP_QUERY = "lsp:query";
