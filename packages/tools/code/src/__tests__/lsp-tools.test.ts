import { describe, it, expect } from "vitest";
import type { LspClient, LspLocation, LspReference, LspDiagnostic, LspHover } from "../lsp-client.js";
import {
  createLspDefinitionTool,
  createLspReferencesTool,
  createLspRenameTool,
  createLspDiagnosticsTool,
  createLspHoverTool,
  LSP_TOOL_NAMES,
} from "../lsp-tools.js";

/**
 * Mock LSP client that returns predetermined responses.
 */
function createMockLspClient(overrides?: {
  definition?: LspLocation[];
  references?: LspReference[];
  rename?: Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } } }>>;
  diagnostics?: LspDiagnostic[];
  hover?: LspHover | null;
}): LspClient {
  return {
    async definition() { return overrides?.definition ?? []; },
    async references() { return overrides?.references ?? []; },
    async rename() { return overrides?.rename ?? {}; },
    async diagnostics() { return overrides?.diagnostics ?? []; },
    async hover() { return overrides?.hover ?? null; },
  };
}

describe("LSP tool names", () => {
  it("all 5 LSP tools are registered", () => {
    expect(LSP_TOOL_NAMES.size).toBe(5);
    expect(LSP_TOOL_NAMES.has("lsp_definition")).toBe(true);
    expect(LSP_TOOL_NAMES.has("lsp_references")).toBe(true);
    expect(LSP_TOOL_NAMES.has("lsp_rename")).toBe(true);
    expect(LSP_TOOL_NAMES.has("lsp_diagnostics")).toBe(true);
    expect(LSP_TOOL_NAMES.has("lsp_hover")).toBe(true);
  });
});

describe("lsp_definition", () => {
  it("returns structured location(s) on success", async () => {
    const client = createMockLspClient({
      definition: [{ uri: "file:///src/foo.ts", range: { start: { line: 10, character: 5 }, end: { line: 10, character: 10 } } }],
    });
    const tool = createLspDefinitionTool(client);
    const result = await tool.handler({ file: "/src/foo.ts", line: 5, character: 3 });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("1 definition");
    expect(result.modelContent).toContain("/src/foo.ts:10:5");
    expect(result.displayMetadata).toBeDefined();
  });

  it("returns message when no definition found", async () => {
    const client = createMockLspClient({ definition: [] });
    const tool = createLspDefinitionTool(client);
    const result = await tool.handler({ file: "/src/foo.ts", line: 5, character: 3 });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("No definition");
  });

  it("returns isError on LSP error (not throw)", async () => {
    const client: LspClient = {
      async definition() { throw new Error("lsp crashed"); },
      async references() { return []; },
      async rename() { return {}; },
      async diagnostics() { return []; },
      async hover() { return null; },
    };
    const tool = createLspDefinitionTool(client);
    const result = await tool.handler({ file: "/src/foo.ts", line: 5, character: 3 });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("lsp crashed");
  });
});

describe("lsp_references", () => {
  it("returns structured references", async () => {
    const client = createMockLspClient({
      references: [
        { uri: "file:///src/a.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
        { uri: "file:///src/b.ts", range: { start: { line: 3, character: 2 }, end: { line: 3, character: 7 } } },
      ],
    });
    const tool = createLspReferencesTool(client);
    const result = await tool.handler({ file: "/src/a.ts", line: 0, character: 0 });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("2 reference");
    expect(result.displayMetadata).toBeDefined();
  });
});

describe("lsp_rename", () => {
  it("returns structured rename changes", async () => {
    const client = createMockLspClient({
      rename: {
        "file:///src/a.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }],
        "file:///src/b.ts": [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } }],
      },
    });
    const tool = createLspRenameTool(client);
    const result = await tool.handler({ file: "/src/a.ts", line: 0, character: 0, newName: "newName" });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("newName");
    expect(result.modelContent).toContain("2 file(s)");
    expect(result.modelContent).toContain("2 edit(s)");
  });

  it("has WRITE_HIGH risk tier", () => {
    const client = createMockLspClient();
    const tool = createLspRenameTool(client);
    expect(tool.definition.riskTier).toBe("WRITE_HIGH");
  });
});

describe("lsp_diagnostics", () => {
  it("returns structured diagnostics", async () => {
    const client = createMockLspClient({
      diagnostics: [
        { range: { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } }, severity: "error", message: "Type mismatch" },
        { range: { start: { line: 10, character: 0 }, end: { line: 10, character: 5 } }, severity: "warning", message: "Unused import" },
      ],
    });
    const tool = createLspDiagnosticsTool(client);
    const result = await tool.handler({ file: "/src/foo.ts" });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("1 error");
    expect(result.modelContent).toContain("1 warning");
    expect(result.modelContent).toContain("Type mismatch");
  });

  it("returns no diagnostics message", async () => {
    const client = createMockLspClient({ diagnostics: [] });
    const tool = createLspDiagnosticsTool(client);
    const result = await tool.handler({ file: "/src/foo.ts" });
    expect(result.modelContent).toContain("No diagnostics");
  });
});

describe("lsp_hover", () => {
  it("returns hover contents", async () => {
    const client = createMockLspClient({
      hover: { contents: "```typescript\nfunction greet(name: string): void\n```" },
    });
    const tool = createLspHoverTool(client);
    const result = await tool.handler({ file: "/src/foo.ts", line: 5, character: 3 });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("function greet");
  });

  it("returns no hover message when null", async () => {
    const client = createMockLspClient({ hover: null });
    const tool = createLspHoverTool(client);
    const result = await tool.handler({ file: "/src/foo.ts", line: 5, character: 3 });
    expect(result.modelContent).toContain("No hover");
  });
});
