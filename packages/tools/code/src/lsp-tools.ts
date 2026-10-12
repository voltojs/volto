import { z } from "zod";
import { defineTool } from "@volto/tools-common";
import type { Tool } from "@volto/tools-common";
import type { LspClient, LspClientProvider, LspDiagnostic } from "./lsp-client.js";
import { CAP_LSP_QUERY } from "./lsp-client.js";
import { fileToUri, uriToFile } from "./lsp-uri.js";

/**
 * The tool layer sits on top of a `LspClientProvider`, so everything the
 * `lsp_*` tools say about failures has to be phrased in terms of a server that
 * is unreachable or unconfigured. These are the codes the Node manager emits
 * (`packages/runtimes/node/src/lsp.ts`); the union is mirrored here rather than
 * imported so `tools-code` stays free of runtime dependencies.
 */
export const LSP_ERROR_CODES = [
  "LSP_SERVER_MISSING",
  "LSP_PATH_OUTSIDE_WORKSPACE",
  "LSP_LANGUAGE_UNCONFIGURED",
  "LSP_UNAVAILABLE",
] as const;

export type LspToolErrorCode = (typeof LSP_ERROR_CODES)[number];

/**
 * Layer-provided guidance per manager code. The manager's message names what
 * went wrong; these lines say what to do about it.
 */
export const LSP_ERROR_TEXT: Record<LspToolErrorCode, string> = {
  LSP_SERVER_MISSING:
    "The language server is not installed, so no request could be answered. " +
    "Install it (for TypeScript: npm install -g typescript-language-server typescript), " +
    'make sure the directory containing it is on PATH, and declare it in lsp.json as {"servers": {"typescript": {"command": "typescript-language-server", "args": ["--stdio"]}}}.',
  LSP_LANGUAGE_UNCONFIGURED:
    "No language server is configured for this file's language, so no request was sent. " +
    'Add an entry for it to lsp.json, for example {"servers": {"python": {"command": "pyright-langserver", "args": ["--stdio"]}}}, where the key is the language id and "command" is the server executable.',
  LSP_PATH_OUTSIDE_WORKSPACE:
    "The file has to be inside the workspace root: the language server only opens documents it can reach from there.",
  LSP_UNAVAILABLE:
    "The language server is unavailable for this session — it failed to start, was shut down, or died repeatedly. Retry in a new session if it should be healthy.",
};

/** Narrow an unknown thrown value to one of the manager's stable codes. */
function errorCodeOf(error: unknown): LspToolErrorCode | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string" && (LSP_ERROR_CODES as readonly string[]).includes(code)
    ? (code as LspToolErrorCode)
    : undefined;
}

/**
 * Render a manager rejection as `CODE: message — guidance`, or as a plain
 * message when the failure is not one of the manager's codes.
 */
export function formatLspError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCodeOf(error);
  if (code === undefined) return message;
  return `${code}: ${message} — ${LSP_ERROR_TEXT[code]}`;
}

/**
 * The tools' one boundary: resolve the file, ask for a client, run the request
 * against the document's canonical URI, and normalize every failure — provider
 * lookup included — into an `isError` result. A throw here would kill the turn.
 */
async function withLspClient(
  provider: LspClientProvider,
  toolName: string,
  file: string,
  fn: (client: LspClient, fileUri: string) => Promise<{ modelContent: string; displayMetadata?: Record<string, unknown> }>,
): Promise<{ modelContent: string; isError?: boolean; displayMetadata?: Record<string, unknown> }> {
  try {
    const client = await provider.forFile(file);
    return await fn(client, fileToUri(file));
  } catch (error) {
    return { modelContent: `${toolName} failed: ${formatLspError(error)}`, isError: true };
  }
}

// ──────────────────────────────────────────────
// Shared input shape
// ──────────────────────────────────────────────

/**
 * Positions are 1-based: line 1, character 1 is the first character of the
 * first line, which is how editors and `read_file` report them. They are
 * converted to the protocol's 0-based values immediately before the call.
 */
const positionSchema = {
  line: z.number().int().min(1).describe("1-based line number."),
  character: z.number().int().min(1).describe("1-based column number."),
};

/**
 * Absolute on purpose: the request URI is built from this value, and a
 * relative path has no workspace root to be resolved against inside the tool.
 * `LspClientProvider` resolves what it is given; the tools cannot.
 */
const fileSchema = z.string().describe("Absolute path of the file to query inside the workspace.");

// ──────────────────────────────────────────────
// lsp_definition — jump to definition
// ──────────────────────────────────────────────

const definitionSchema = z.object({
  file: fileSchema,
  ...positionSchema,
});

export function createLspDefinitionTool(provider: LspClientProvider): Tool {
  return defineTool({
    name: "lsp_definition",
    description: "Jump to the definition of a symbol at a given position. Returns structured location(s) with file path and range.",
    schema: definitionSchema,
    requires: [CAP_LSP_QUERY],
    riskTier: "READ_ONLY",
    pathInputs: ["file"],
    run: async ({ file, line, character }) =>
      withLspClient(provider, "lsp_definition", file, async (client, uri) => {
        const locations = await client.definition(uri, line - 1, character - 1);
        if (locations.length === 0) {
          return { modelContent: `No definition found at ${file}:${line}:${character}.` };
        }
        const results = locations.map((loc) => ({
          file: uriToFile(loc.uri),
          range: loc.range,
        }));
        return {
          modelContent: `Found ${results.length} definition(s):\n${results.map((r) => `  ${r.file}:${r.range.start.line + 1}:${r.range.start.character + 1}`).join("\n")}`,
          displayMetadata: { locations: results },
        };
      }),
  });
}

// ──────────────────────────────────────────────
// lsp_references — find all references
// ──────────────────────────────────────────────

const referencesSchema = z.object({
  file: fileSchema,
  ...positionSchema,
});

export function createLspReferencesTool(provider: LspClientProvider): Tool {
  return defineTool({
    name: "lsp_references",
    description: "Find all references to a symbol at a given position. Returns structured list of file + range locations.",
    schema: referencesSchema,
    requires: [CAP_LSP_QUERY],
    riskTier: "READ_ONLY",
    pathInputs: ["file"],
    run: async ({ file, line, character }) =>
      withLspClient(provider, "lsp_references", file, async (client, uri) => {
        const refs = await client.references(uri, line - 1, character - 1);
        if (refs.length === 0) {
          return { modelContent: `No references found for symbol at ${file}:${line}:${character}.` };
        }
        const results = refs.map((ref) => ({
          file: uriToFile(ref.uri),
          range: ref.range,
        }));
        return {
          modelContent: `Found ${results.length} reference(s):\n${results.map((r) => `  ${r.file}:${r.range.start.line + 1}:${r.range.start.character + 1}`).join("\n")}`,
          displayMetadata: { references: results },
        };
      }),
  });
}

// ──────────────────────────────────────────────
// lsp_rename — rename a symbol
// ──────────────────────────────────────────────

const renameSchema = z.object({
  file: fileSchema,
  ...positionSchema,
  newName: z.string().describe("New name for the symbol."),
});

export function createLspRenameTool(provider: LspClientProvider): Tool {
  return defineTool({
    name: "lsp_rename",
    description: "Rename a symbol and get all locations that need updating. Returns a map of file → affected ranges. Does NOT write changes — use edit_file to apply.",
    schema: renameSchema,
    requires: [CAP_LSP_QUERY],
    // Read-only on purpose: this call computes and returns a preview; nothing is
    // written until the model applies the edits itself with edit_file.
    riskTier: "READ_ONLY",
    pathInputs: ["file"],
    run: async ({ file, line, character, newName }) =>
      withLspClient(provider, "lsp_rename", file, async (client, uri) => {
        const changes = await client.rename(uri, line - 1, character - 1, newName);
        const fileCount = Object.keys(changes).length;
        const totalEdits = Object.values(changes).reduce((sum, edits) => sum + edits.length, 0);
        if (fileCount === 0) {
          return { modelContent: `No renames needed at ${file}:${line}:${character}. Symbol may not exist or name is the same.` };
        }
        const summary = Object.entries(changes)
          .map(([target, edits]) => `  ${uriToFile(target)}: ${edits.length} edit(s)`)
          .join("\n");
        return {
          modelContent: `Rename "${newName}": ${totalEdits} edit(s) across ${fileCount} file(s):\n${summary}`,
          displayMetadata: { changes, newName },
        };
      }),
  });
}

// ──────────────────────────────────────────────
// lsp_diagnostics — get diagnostics for a file
// ──────────────────────────────────────────────

const diagnosticsSchema = z.object({
  file: fileSchema,
});

/** How many diagnostics are spelled out before the list is summarized. */
const MAX_RENDERED_DIAGNOSTICS = 20;

/**
 * The four states a diagnostics answer can be in, keyed by the report's
 * `source` rather than by `diagnostics.length`.
 *
 * A bare empty array cannot distinguish "the server answered and the file is
 * clean" from "the server has not reported on this file yet" — rendering both
 * as "no diagnostics" presents a still-indexing server as a clean bill of
 * health. `source` is the only field that carries that difference.
 */
function renderDiagnostics(file: string, report: { diagnostics: LspDiagnostic[]; source: "pull" | "push" | "none" }): string {
  const { diagnostics, source } = report;

  if (diagnostics.length === 0) {
    if (source === "none") {
      return `${file}: the language server has not reported diagnostics for this file yet, so this is not a clean bill of health — it may still be indexing. Ask again in a moment.`;
    }
    // "pull": asked and answered with an empty list. "push": the server
    // reported (or last reported) this file and had nothing to say.
    return `${file}: no problems reported by the language server (${source} diagnostics).`;
  }

  const count = (severity: LspDiagnostic["severity"]): number =>
    diagnostics.filter((diagnostic) => diagnostic.severity === severity).length;
  const shown = diagnostics.slice(0, MAX_RENDERED_DIAGNOSTICS);
  const body = shown
    .map((diagnostic) => `  [${diagnostic.severity}] ${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}: ${diagnostic.message}`)
    .join("\n");
  const truncated =
    diagnostics.length > shown.length ? `\n  ... and ${diagnostics.length - shown.length} more` : "";

  return (
    `${file}: ${count("error")} error(s), ${count("warning")} warning(s), ${diagnostics.length} total ` +
    `(${source}):\n${body}${truncated}`
  );
}

export function createLspDiagnosticsTool(provider: LspClientProvider): Tool {
  return defineTool({
    name: "lsp_diagnostics",
    description: "Get diagnostics (errors, warnings) for a file from the language server. An empty result only means 'clean' when the server has actually reported on the file; the text says which case it is.",
    schema: diagnosticsSchema,
    requires: [CAP_LSP_QUERY],
    riskTier: "READ_ONLY",
    pathInputs: ["file"],
    run: async ({ file }) =>
      withLspClient(provider, "lsp_diagnostics", file, async (client, uri) => {
        const report = await client.diagnostics(uri);
        return {
          modelContent: renderDiagnostics(file, report),
          displayMetadata: {
            file,
            source: report.source,
            diagnostics: report.diagnostics,
          },
        };
      }),
  });
}

// ──────────────────────────────────────────────
// lsp_hover — get hover info at position
// ──────────────────────────────────────────────

const hoverSchema = z.object({
  file: fileSchema,
  ...positionSchema,
});

export function createLspHoverTool(provider: LspClientProvider): Tool {
  return defineTool({
    name: "lsp_hover",
    description: "Get hover information (type signature, documentation) at a given position.",
    schema: hoverSchema,
    requires: [CAP_LSP_QUERY],
    riskTier: "READ_ONLY",
    pathInputs: ["file"],
    run: async ({ file, line, character }) =>
      withLspClient(provider, "lsp_hover", file, async (client, uri) => {
        const hover = await client.hover(uri, line - 1, character - 1);
        if (!hover) {
          return { modelContent: `No hover information at ${file}:${line}:${character}.` };
        }
        return {
          modelContent: hover.contents,
          displayMetadata: { file, line, character },
        };
      }),
  });
}

export const LSP_TOOL_NAMES: ReadonlySet<string> = new Set([
  "lsp_definition",
  "lsp_references",
  "lsp_rename",
  "lsp_diagnostics",
  "lsp_hover",
]);
