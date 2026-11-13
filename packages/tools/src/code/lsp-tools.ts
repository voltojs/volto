import { z } from "zod";
import { defineTool } from "../common/index.js";
import type { Tool } from "../common/index.js";
import type { ToolResultBlock } from "@voltojs/core";
import type { LspClient, LspClientProvider, LspDiagnostic, LspDocumentReference } from "./lsp-client.js";
import { CAP_LSP_QUERY } from "./lsp-client.js";
import { uriToFile } from "./lsp-uri.js";

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
    'make sure the directory containing it is on PATH, and declare it in ~/.volto/lsp.json as {"servers": {"typescript": {"command": "typescript-language-server", "args": ["--stdio"]}}}.',
  LSP_LANGUAGE_UNCONFIGURED:
    "No language server is configured for this file's language, so no request was sent. " +
    'Add an entry for it to ~/.volto/lsp.json, for example {"servers": {"python": {"command": "pyright-langserver", "args": ["--stdio"]}}}, where the key is the language id and "command" is the server executable.',
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
 * against that same file as the document reference, and normalize every failure
 * — provider lookup included — into an `isError` result. A throw here would
 * kill the turn.
 *
 * The reference is passed through **verbatim**: document identity (canonical
 * URI, workspace containment, document sync) belongs to the manager, and a
 * relative path has no workspace root to be resolved against in here.
 */
async function withLspClient(
  provider: LspClientProvider,
  toolName: string,
  file: string,
  fn: (client: LspClient, document: LspDocumentReference) => Promise<{ modelContent: string | ToolResultBlock[]; displayMetadata?: Record<string, unknown> }>,
): Promise<{ modelContent: string | ToolResultBlock[]; isError?: boolean; displayMetadata?: Record<string, unknown> }> {
  try {
    const client = await provider.forFile(file);
    return await fn(client, file);
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
 * The tools pass this through untouched. A relative path is resolved against
 * the workspace root by the provider (which owns the boundary), so the model
 * can name a file the way `read_file` and `edit_file` accept it.
 */
const fileSchema = z
  .string()
  .describe("File to query: an absolute path, or a path relative to the workspace root.");

// ──────────────────────────────────────────────
// Result rendering
// ──────────────────────────────────────────────

/**
 * A location's file for display.
 *
 * A location URI is not always a `file:` one (`jdt://`, `rust-analyzer://`
 * and virtual documents all exist), and `uriToFile` rejects those. One
 * undecodable location must not cost the caller the whole answer, so the raw
 * URI is rendered instead of throwing. A `file:` URI that merely lacks a
 * leading slash is normalized before decoding, because `fileToUri` always
 * emits `file:///…` and JSON-RPC servers are free to trim that third slash.
 */
function locationFile(uri: string): string {
  const withThirdSlash = /^file:\/\//i.test(uri) ? `file:///${uri.slice("file://".length).replace(/^\/+/, "")}` : uri;
  try {
    return uriToFile(withThirdSlash);
  } catch {
    // Not a disk path at all — `jdt://`, `rust-analyzer://` and friends have no
    // filesystem spelling, so rendering the URI verbatim beats failing the
    // whole call over one location.
    return uri;
  }
}

/** Render one `file:line:character` entry, 1-based to match `read_file`. */
function renderLocation(uri: string, range: { start: { line: number; character: number } }): string {
  return `  ${locationFile(uri)}:${range.start.line + 1}:${range.start.character + 1}`;
}

/**
 * The single place a location list becomes text: `Found N <noun>(s):` plus
 * one rendered line per location. Both tools render through this function —
 * the legacy plain-string answer and the structured block's required `text`
 * projection are the same bytes by construction, so they cannot drift.
 */
function renderLocationList(
  count: number,
  noun: "definition" | "reference",
  locations: ReadonlyArray<{ uri: string; range: { start: { line: number; character: number } } }>,
): string {
  return `Found ${count} ${noun}(s):\n${locations.map((loc) => renderLocation(loc.uri, loc.range)).join("\n")}`;
}

/**
 * The `lsp.locations` data shape (spec §4.2): the server's own range objects,
 * LSP-native 0-based line/character — deliberately NOT the 1-based rendering
 * coordinates, so consumers get one coordinate system from the protocol and
 * one (derived) for display.
 */
interface LspLocationsData {
  locations: Array<{
    uri: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
  }>;
}

/**
 * One structured block for a location answer. `data` carries the locations
 * verbatim; `text` is the byte-identical legacy rendering — the single
 * degradation exit every provider/trimming path uses.
 */
function locationsBlock(
  count: number,
  noun: "definition" | "reference",
  locations: LspLocationsData["locations"],
): ToolResultBlock {
  return {
    type: "structured",
    kind: "lsp.locations",
    data: { locations } satisfies LspLocationsData,
    text: renderLocationList(count, noun, locations),
  };
}

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
      withLspClient(provider, "lsp_definition", file, async (client, document) => {
        const locations = await client.definition(document, line - 1, character - 1);
        if (locations.length === 0) {
          return { modelContent: `No definition found at ${file}:${line}:${character}.` };
        }
        const results = locations.map((loc) => ({
          uri: loc.uri,
          range: loc.range,
        }));
        return {
          modelContent: [locationsBlock(results.length, "definition", results)],
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
      withLspClient(provider, "lsp_references", file, async (client, document) => {
        const refs = await client.references(document, line - 1, character - 1);
        if (refs.length === 0) {
          return { modelContent: `No references found for symbol at ${file}:${line}:${character}.` };
        }
        const results = refs.map((ref) => ({
          uri: ref.uri,
          range: ref.range,
        }));
        return {
          modelContent: [locationsBlock(results.length, "reference", results)],
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
      withLspClient(provider, "lsp_rename", file, async (client, document) => {
        const changes = await client.rename(document, line - 1, character - 1, newName);
        const fileCount = Object.keys(changes).length;
        const totalEdits = Object.values(changes).reduce((sum, edits) => sum + edits.length, 0);
        if (fileCount === 0) {
          return { modelContent: `No renames needed at ${file}:${line}:${character}. Symbol may not exist or name is the same.` };
        }
        const summary = Object.entries(changes)
          .map(([target, edits]) => `  ${locationFile(target)}: ${edits.length} edit(s)`)
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
 * health. `source` is the only field that carries that difference, and the
 * clean state keeps the spec's parseable `0 error(s), 0 warning(s)` form.
 */
function renderDiagnostics(file: string, report: { diagnostics: LspDiagnostic[]; source: "pull" | "push" | "none" }): string {
  const { diagnostics, source } = report;

  if (diagnostics.length === 0 && source === "none") {
    return `${file}: the language server has not reported diagnostics for this file yet, so this is not a clean bill of health — it may still be indexing. Ask again in a moment.`;
  }

  const count = (severity: LspDiagnostic["severity"]): number =>
    diagnostics.filter((diagnostic) => diagnostic.severity === severity).length;
  const shown = diagnostics.slice(0, MAX_RENDERED_DIAGNOSTICS);
  const truncated =
    diagnostics.length > shown.length ? `\n  ... and ${diagnostics.length - shown.length} more` : "";
  const body = shown
    .map((diagnostic) => `  [${diagnostic.severity}] ${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}: ${diagnostic.message}`)
    .join("\n");

  // Also the "reported and empty" state (`pull` answered empty, or the `push`
  // cache holds an empty report) — the counts say so without prose.
  return (
    `${file}: ${count("error")} error(s), ${count("warning")} warning(s), ${diagnostics.length} total ` +
    `(${source}):${body === "" ? "" : `\n${body}`}${truncated}`
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
      withLspClient(provider, "lsp_diagnostics", file, async (client, document) => {
        const report = await client.diagnostics(document);
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
      withLspClient(provider, "lsp_hover", file, async (client, document) => {
        const hover = await client.hover(document, line - 1, character - 1);
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
