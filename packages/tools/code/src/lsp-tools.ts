import { z } from "zod";
import { defineTool } from "@volto/tools-common";
import type { Tool } from "@volto/tools-common";
import type { LspClient } from "./lsp-client.js";
import { CAP_LSP_QUERY } from "./lsp-client.js";

// ──────────────────────────────────────────────
// lsp_definition — jump to definition
// ──────────────────────────────────────────────

const definitionSchema = z.object({
  file: z.string().describe("Absolute file path."),
  line: z.number().int().min(0).describe("0-based line number."),
  character: z.number().int().min(0).describe("0-based column number."),
});

export function createLspDefinitionTool(client: LspClient): Tool {
  return defineTool({
    name: "lsp_definition",
    description: "Jump to the definition of a symbol at a given position. Returns structured location(s) with file path and range.",
    schema: definitionSchema,
    requires: [CAP_LSP_QUERY],
    riskTier: "READ_ONLY",
    run: async ({ file, line, character }) => {
      try {
        const uri = fileToUri(file);
        const locations = await client.definition(uri, line, character);
        if (locations.length === 0) {
          return { modelContent: `No definition found at ${file}:${line}:${character}.` };
        }
        const results = locations.map((loc) => ({
          file: uriToFile(loc.uri),
          range: loc.range,
        }));
        return {
          modelContent: `Found ${results.length} definition(s):\n${results.map((r) => `  ${r.file}:${r.range.start.line}:${r.range.start.character}`).join("\n")}`,
          displayMetadata: { locations: results },
        };
      } catch (err) {
        return { modelContent: `lsp_definition failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

// ──────────────────────────────────────────────
// lsp_references — find all references
// ──────────────────────────────────────────────

const referencesSchema = z.object({
  file: z.string().describe("Absolute file path."),
  line: z.number().int().min(0).describe("0-based line number."),
  character: z.number().int().min(0).describe("0-based column number."),
});

export function createLspReferencesTool(client: LspClient): Tool {
  return defineTool({
    name: "lsp_references",
    description: "Find all references to a symbol at a given position. Returns structured list of file + range locations.",
    schema: referencesSchema,
    requires: [CAP_LSP_QUERY],
    riskTier: "READ_ONLY",
    run: async ({ file, line, character }) => {
      try {
        const uri = fileToUri(file);
        const refs = await client.references(uri, line, character);
        if (refs.length === 0) {
          return { modelContent: `No references found for symbol at ${file}:${line}:${character}.` };
        }
        const results = refs.map((ref) => ({
          file: uriToFile(ref.uri),
          range: ref.range,
        }));
        return {
          modelContent: `Found ${results.length} reference(s):\n${results.map((r) => `  ${r.file}:${r.range.start.line}:${r.range.start.character}`).join("\n")}`,
          displayMetadata: { references: results },
        };
      } catch (err) {
        return { modelContent: `lsp_references failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

// ──────────────────────────────────────────────
// lsp_rename — rename a symbol
// ──────────────────────────────────────────────

const renameSchema = z.object({
  file: z.string().describe("Absolute file path."),
  line: z.number().int().min(0).describe("0-based line number."),
  character: z.number().int().min(0).describe("0-based column number."),
  newName: z.string().describe("New name for the symbol."),
});

export function createLspRenameTool(client: LspClient): Tool {
  return defineTool({
    name: "lsp_rename",
    description: "Rename a symbol and get all locations that need updating. Returns a map of file → affected ranges. Does NOT write changes — use edit_file to apply.",
    schema: renameSchema,
    requires: [CAP_LSP_QUERY],
    riskTier: "WRITE_HIGH",
    run: async ({ file, line, character, newName }) => {
      try {
        const uri = fileToUri(file);
        const changes = await client.rename(uri, line, character, newName);
        const fileCount = Object.keys(changes).length;
        const totalEdits = Object.values(changes).reduce((sum, edits) => sum + edits.length, 0);
        if (fileCount === 0) {
          return { modelContent: `No renames needed at ${file}:${line}:${character}. Symbol may not exist or name is the same.` };
        }
        const summary = Object.entries(changes)
          .map(([f, edits]) => `  ${uriToFile(f)}: ${edits.length} edit(s)`)
          .join("\n");
        return {
          modelContent: `Rename "${newName}": ${totalEdits} edit(s) across ${fileCount} file(s):\n${summary}`,
          displayMetadata: { changes, newName },
        };
      } catch (err) {
        return { modelContent: `lsp_rename failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

// ──────────────────────────────────────────────
// lsp_diagnostics — get diagnostics for a file
// ──────────────────────────────────────────────

const diagnosticsSchema = z.object({
  file: z.string().describe("Absolute file path."),
});

export function createLspDiagnosticsTool(client: LspClient): Tool {
  return defineTool({
    name: "lsp_diagnostics",
    description: "Get diagnostics (errors, warnings) for a file from the language server.",
    schema: diagnosticsSchema,
    requires: [CAP_LSP_QUERY],
    riskTier: "READ_ONLY",
    run: async ({ file }) => {
      try {
        const uri = fileToUri(file);
        const report = await client.diagnostics(uri);
        const diags = report.diagnostics;
        if (diags.length === 0) {
          return { modelContent: `No diagnostics for ${file}.` };
        }
        const errors = diags.filter((d) => d.severity === "error").length;
        const warnings = diags.filter((d) => d.severity === "warning").length;
        const summary = diags.slice(0, 20).map((d) =>
          `  [${d.severity}] ${d.range.start.line}:${d.range.start.character}: ${d.message}`,
        ).join("\n");
        const truncated = diags.length > 20 ? `\n  ... and ${diags.length - 20} more` : "";
        return {
          modelContent: `${file}: ${errors} error(s), ${warnings} warning(s), ${diags.length} total:\n${summary}${truncated}`,
          displayMetadata: { diagnostics: diags, file },
        };
      } catch (err) {
        return { modelContent: `lsp_diagnostics failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

// ──────────────────────────────────────────────
// lsp_hover — get hover info at position
// ──────────────────────────────────────────────

const hoverSchema = z.object({
  file: z.string().describe("Absolute file path."),
  line: z.number().int().min(0).describe("0-based line number."),
  character: z.number().int().min(0).describe("0-based column number."),
});

export function createLspHoverTool(client: LspClient): Tool {
  return defineTool({
    name: "lsp_hover",
    description: "Get hover information (type signature, documentation) at a given position.",
    schema: hoverSchema,
    requires: [CAP_LSP_QUERY],
    riskTier: "READ_ONLY",
    run: async ({ file, line, character }) => {
      try {
        const uri = fileToUri(file);
        const hover = await client.hover(uri, line, character);
        if (!hover) {
          return { modelContent: `No hover information at ${file}:${line}:${character}.` };
        }
        return {
          modelContent: hover.contents,
          displayMetadata: { file, line, character },
        };
      } catch (err) {
        return { modelContent: `lsp_hover failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function fileToUri(file: string): string {
  return file.startsWith("file://") ? file : `file://${file}`;
}

function uriToFile(uri: string): string {
  return uri.startsWith("file://") ? uri.slice(7) : uri;
}

export const LSP_TOOL_NAMES: ReadonlySet<string> = new Set([
  "lsp_definition",
  "lsp_references",
  "lsp_rename",
  "lsp_diagnostics",
  "lsp_hover",
]);
