import { describe, expect, it } from "vitest";
import type { LspClient, LspDiagnostic, LspDiagnosticReport, LspHover, LspLocation, LspReference } from "../lsp-client.js";
import {
  LSP_ERROR_TEXT,
  LSP_ERROR_CODES,
  createLspDefinitionTool,
  createLspDiagnosticsTool,
  createLspHoverTool,
  createLspReferencesTool,
  createLspRenameTool,
  formatLspError,
  LSP_TOOL_NAMES,
} from "../lsp-tools.js";

/**
 * Wire-level record of what the tools actually asked the client for.
 *
 * The position assertions are made against this — not against a value the
 * tool happened to return — so a tool that silently forwards a 1-based
 * position cannot pass by echoing it back.
 */
interface RecordedCall {
  method: string;
  /** The document reference the tool handed to the client, verbatim. */
  document?: string;
  line?: number;
  character?: number;
  newName?: string;
}

type RenameChanges = Record<
  string,
  Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } } }>
>;

interface Responses {
  definition?: LspLocation[];
  references?: LspReference[];
  rename?: RenameChanges;
  hover?: LspHover | null;
}

/** Everything the fake server needs to answer `diagnostics()`. */
interface PushConfig {
  source: "pull" | "push" | "none";
  diagnostics?: LspDiagnostic[];
}

interface FakeClient extends LspClient {
  calls: RecordedCall[];
  /** Latest diagnostics answer; mutable so one client can cover every state. */
  publish: PushConfig;
}

function fakeClient(responses: Responses = {}, publish: PushConfig = { source: "none" }): FakeClient {
  const calls: RecordedCall[] = [];
  return {
    calls,
    publish,
    async definition(document, line, character) {
      calls.push({ method: "definition", document, line, character });
      return responses.definition ?? [];
    },
    async references(document, line, character) {
      calls.push({ method: "references", document, line, character });
      return responses.references ?? [];
    },
    async rename(document, line, character, newName) {
      calls.push({ method: "rename", document, line, character, newName });
      return responses.rename ?? {};
    },
    async diagnostics(document): Promise<LspDiagnosticReport> {
      calls.push({ method: "diagnostics", document });
      return { diagnostics: publish.diagnostics ?? [], source: publish.source };
    },
    async hover(document, line, character) {
      calls.push({ method: "hover", document, line, character });
      return responses.hover ?? null;
    },
  };
}

/** A provider stub: the tools must never see anything but `forFile`. */
function providerStub(client: LspClient, record?: string[]): { forFile(file: string): Promise<LspClient> } {
  return {
    async forFile(file: string) {
      record?.push(file);
      return client;
    },
  };
}

/** The manager's rejection shape: an Error carrying one of its stable codes. */
function managerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** A provider whose `forFile` fails the way the real manager does. */
function failingProvider(code: string, message: string) {
  return {
    async forFile(): Promise<LspClient> {
      throw managerError(code, message);
    },
  };
}

const FILE = "/repo/src/a.ts";

/**
 * The LSP tools always answer with text metadata; this narrowing keeps the
 * provenance assertions below type-safe instead of comparing against a block
 * array, and fails loudly if that ever stops being true.
 */
function text(modelContent: unknown): string {
  if (typeof modelContent !== "string") {
    throw new TypeError(`expected text modelContent, received ${typeof modelContent}`);
  }
  return modelContent;
}

const zeroRange = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 5 },
};

/**
 * F-005: narrow a location tool's success result to its ONE structured block.
 * Throws loudly on any other shape — a plain string or a multi-block result
 * must fail here, not pass as "empty".
 */
function structuredBlock(modelContent: unknown): {
  type: "structured";
  kind: string;
  data: unknown;
  text: string;
} {
  if (!Array.isArray(modelContent) || modelContent.length !== 1) {
    throw new TypeError(
      `expected exactly one result block, received ${JSON.stringify(modelContent)}`,
    );
  }
  const block: unknown = modelContent[0];
  if (typeof block !== "object" || block === null || (block as { type?: unknown }).type !== "structured") {
    throw new TypeError(`expected a structured block, received ${JSON.stringify(block)}`);
  }
  return block as { type: "structured"; kind: string; data: unknown; text: string };
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
    const client = fakeClient({
      definition: [{ uri: "file:///src/foo.ts", range: { start: { line: 10, character: 5 }, end: { line: 10, character: 10 } } }],
    });
    const tool = createLspDefinitionTool(providerStub(client));
    const result = await tool.handler({ file: FILE, line: 6, character: 4 });
    expect(result.isError).toBeFalsy();
    const block = structuredBlock(result.modelContent);
    expect(block.text).toContain("1 definition");
    expect(block.text).toContain("/src/foo.ts:11:6");
    expect(result.displayMetadata).toBeDefined();
  });

  it("returns message when no definition found", async () => {
    const tool = createLspDefinitionTool(providerStub(fakeClient({ definition: [] })));
    const result = await tool.handler({ file: FILE, line: 6, character: 4 });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("No definition");
  });

  it("returns isError on LSP error (not throw)", async () => {
    const client: LspClient = {
      ...fakeClient(),
      async definition() {
        throw new Error("lsp crashed");
      },
    };
    const tool = createLspDefinitionTool(providerStub(client));
    const result = await tool.handler({ file: FILE, line: 6, character: 4 });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("lsp crashed");
  });

  it("F-120 passes the path through to the provider and the client unchanged", async () => {
    const visits: string[] = [];
    const client = fakeClient();
    await createLspDefinitionTool(providerStub(client, visits)).handler({ file: FILE, line: 1, character: 1 });

    expect(visits).toEqual([FILE]);
    // The tool constructs no URI at all: document identity is the provider's.
    expect(client.calls[0]?.document).toBe(FILE);
  });

  it("F-120 passes a workspace-relative path through unchanged", async () => {
    const visits: string[] = [];
    const client = fakeClient();
    await createLspDefinitionTool(providerStub(client, visits)).handler({ file: "src/a.ts", line: 1, character: 1 });

    expect(visits).toEqual(["src/a.ts"]);
    expect(client.calls[0]?.document).toBe("src/a.ts");
  });

  it("F-120 converts 1-based line and character to 0-based before the call", async () => {
    const client = fakeClient({
      definition: [{ uri: "file:///repo/src/a.ts", range: zeroRange }],
    });
    const tool = createLspDefinitionTool(providerStub(client));
    await tool.handler({ file: FILE, line: 1, character: 1 });

    // The wire message, not the returned value: the fixture echoes nothing
    // back, so only the recorded request can prove the conversion happened.
    expect(client.calls[0]).toMatchObject({ method: "definition", line: 0, character: 0 });

    await tool.handler({ file: FILE, line: 12, character: 7 });
    expect(client.calls[1]).toMatchObject({ method: "definition", line: 11, character: 6 });
  });
});

describe("lsp_references", () => {
  it("returns structured references", async () => {
    const client = fakeClient({
      references: [
        { uri: "file:///src/a.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
        { uri: "file:///src/b.ts", range: { start: { line: 3, character: 2 }, end: { line: 3, character: 7 } } },
      ],
    });
    const tool = createLspReferencesTool(providerStub(client));
    const result = await tool.handler({ file: FILE, line: 1, character: 1 });
    expect(result.isError).toBeFalsy();
    expect(structuredBlock(result.modelContent).text).toContain("2 reference");
    expect(result.displayMetadata).toBeDefined();
  });

  it("F-120 passes the position through as 0-based on the wire", async () => {
    const client = fakeClient();
    await createLspReferencesTool(providerStub(client)).handler({ file: FILE, line: 3, character: 9 });
    expect(client.calls[0]).toMatchObject({ method: "references", line: 2, character: 8 });
  });
});

describe("F-205 structured lsp.locations blocks", () => {
  /** The two LSP answers: native 0-based ranges, exactly as the server sent them. */
  const DEFINITION_RESULTS = [
    { uri: "file:///src/a.ts", range: { start: { line: 10, character: 5 }, end: { line: 10, character: 12 } } },
    { uri: "file:///src/b.ts", range: { start: { line: 3, character: 2 }, end: { line: 3, character: 9 } } },
  ];

  /**
   * The pre-structured rendering, spelled out byte for byte: the old format is
   * `Found N definition(s):\n` + one `  <path>:<line+1>:<character+1>` per
   * location. The tool's `text` projection must equal this string exactly —
   * any drift between the two renderings is what this literal catches.
   */
  const OLD_DEFINITION_TEXT =
    "Found 2 definition(s):\n  /src/a.ts:11:6\n  /src/b.ts:4:3";

  const REFERENCE_RESULTS = [
    { uri: "file:///src/a.ts", range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } } },
    { uri: "file:///src/b.ts", range: { start: { line: 7, character: 8 }, end: { line: 8, character: 0 } } },
  ];

  const OLD_REFERENCE_TEXT =
    "Found 2 reference(s):\n  /src/a.ts:2:1\n  /src/b.ts:8:9";

  it("lsp_definition returns exactly one structured block (kind lsp.locations, LSP-native data)", async () => {
    const client = fakeClient({ definition: DEFINITION_RESULTS });
    const result = await createLspDefinitionTool(providerStub(client)).handler({
      file: FILE,
      line: 6,
      character: 4,
    });

    expect(result.isError).toBeFalsy();
    const block = structuredBlock(result.modelContent);
    expect(block.kind).toBe("lsp.locations");
    // Data carries the server's own 0-based ranges — no second coordinate
    // system: line 10 stays 10 in data while the text projection renders 11.
    expect(block.data).toEqual({ locations: DEFINITION_RESULTS });
  });

  it("lsp_definition text projection is byte-identical to the old string rendering", async () => {
    const client = fakeClient({ definition: DEFINITION_RESULTS });
    const result = await createLspDefinitionTool(providerStub(client)).handler({
      file: FILE,
      line: 6,
      character: 4,
    });

    expect(structuredBlock(result.modelContent).text).toBe(OLD_DEFINITION_TEXT);
  });

  it("lsp_references returns exactly one structured block (kind lsp.locations, LSP-native data)", async () => {
    const client = fakeClient({ references: REFERENCE_RESULTS });
    const result = await createLspReferencesTool(providerStub(client)).handler({
      file: FILE,
      line: 2,
      character: 1,
    });

    expect(result.isError).toBeFalsy();
    const block = structuredBlock(result.modelContent);
    expect(block.kind).toBe("lsp.locations");
    expect(block.data).toEqual({ locations: REFERENCE_RESULTS });
  });

  it("lsp_references text projection is byte-identical to the old string rendering", async () => {
    const client = fakeClient({ references: REFERENCE_RESULTS });
    const result = await createLspReferencesTool(providerStub(client)).handler({
      file: FILE,
      line: 2,
      character: 1,
    });

    expect(structuredBlock(result.modelContent).text).toBe(OLD_REFERENCE_TEXT);
  });

  it("keeps the no-result paths plain strings (structured blocks don't carry absence)", async () => {
    const definition = await createLspDefinitionTool(
      providerStub(fakeClient({ definition: [] })),
    ).handler({ file: FILE, line: 6, character: 4 });
    expect(typeof definition.modelContent).toBe("string");

    const references = await createLspReferencesTool(
      providerStub(fakeClient({ references: [] })),
    ).handler({ file: FILE, line: 6, character: 4 });
    expect(typeof references.modelContent).toBe("string");
  });

  it("keeps the error paths plain strings with isError (structured blocks don't carry errors)", async () => {
    const client: LspClient = {
      ...fakeClient(),
      async definition() {
        throw new Error("lsp crashed");
      },
    };
    const result = await createLspDefinitionTool(providerStub(client)).handler({
      file: FILE,
      line: 6,
      character: 4,
    });
    expect(result.isError).toBe(true);
    expect(typeof result.modelContent).toBe("string");
    expect(result.modelContent).toContain("lsp crashed");
  });
});

describe("lsp_rename", () => {
  it("returns structured rename changes", async () => {
    const client = fakeClient({
      rename: {
        "file:///src/a.ts": [{ range: zeroRange }],
        "file:///src/b.ts": [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } }],
      },
    });
    const tool = createLspRenameTool(providerStub(client));
    const result = await tool.handler({ file: FILE, line: 1, character: 1, newName: "newName" });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("newName");
    expect(result.modelContent).toContain("2 file(s)");
    expect(result.modelContent).toContain("2 edit(s)");
  });

  it("F-120 is READ_ONLY: it only previews, the caller applies the edits", async () => {
    const tool = createLspRenameTool(providerStub(fakeClient()));
    expect(tool.definition.riskTier).toBe("READ_ONLY");
  });

  it("F-120 sends the 0-based position, the new name and the path unchanged", async () => {
    const client = fakeClient();
    await createLspRenameTool(providerStub(client)).handler({ file: FILE, line: 4, character: 2, newName: "renamed" });
    expect(client.calls[0]).toMatchObject({
      method: "rename",
      document: FILE,
      line: 3,
      character: 1,
      newName: "renamed",
    });
  });
});

describe("F-120 schema: 1-based inputs and declared path inputs", () => {
  const factories = [
    ["lsp_definition", createLspDefinitionTool],
    ["lsp_references", createLspReferencesTool],
    ["lsp_rename", createLspRenameTool],
    ["lsp_diagnostics", createLspDiagnosticsTool],
    ["lsp_hover", createLspHoverTool],
  ] as const;

  it("declares file as a path input and stays read-only", () => {
    for (const [name, factory] of factories) {
      expect(factory(providerStub(fakeClient())).definition.pathInputs, name).toEqual(["file"]);
      expect(factory(providerStub(fakeClient())).definition.riskTier, name).toBe("READ_ONLY");
    }
  });

  it.each(["lsp_definition", "lsp_references", "lsp_rename", "lsp_hover"])(
    "%s rejects line = 0 and character = 0 (1-based)",
    async (name) => {
      const factory = factories.find(([toolName]) => toolName === name)![1];
      const tool = factory(providerStub(fakeClient()));

      const bad = await tool.handler({ file: FILE, line: 0, character: 0, newName: "x" });
      expect(bad.isError).toBe(true);
      expect(bad.modelContent).toContain("line");
    },
  );

  it("accepts line = 1 and character = 1 as the first position", async () => {
    const client = fakeClient();
    const result = await createLspHoverTool(providerStub(client)).handler({ file: FILE, line: 1, character: 1 });
    expect(result.isError).toBeFalsy();
    expect(client.calls[0]).toMatchObject({ line: 0, character: 0 });
  });
});

describe("F-120 URI round trip: percent-encoded and non-ASCII file:// URIs", () => {
  it("passes a path with spaces and non-ASCII characters through verbatim", async () => {
    const client = fakeClient();
    await createLspDefinitionTool(providerStub(client)).handler({
      file: "/repo/中文/a b.ts",
      line: 1,
      character: 1,
    });
    // No percent-encoding is the tool's job: the manager derives the canonical
    // URI from this path and syncs that document.
    expect(client.calls[0]?.document).toBe("/repo/中文/a b.ts");
  });

  it("decodes an encoded definition location back to a disk path", async () => {
    const tool = createLspDefinitionTool(
      providerStub(fakeClient({ definition: [{ uri: "file:///tmp/%E4%B8%AD%E6%96%87/a%20b.ts", range: zeroRange }] })),
    );
    const res = await tool.handler({ file: FILE, line: 1, character: 1 });
    expect(structuredBlock(res.modelContent).text).toContain("/tmp/中文/a b.ts");
  });

  it("renders a foreign-scheme location verbatim instead of failing the whole call", async () => {
    const client = fakeClient({
      definition: [
        { uri: "file:///repo/src/a.ts", range: { start: { line: 9, character: 4 }, end: { line: 9, character: 9 } } },
        // A language server is free to answer with a non-`file:` scheme; one
        // undecodable location must not discard the decodable ones.
        { uri: "jdt://contents/java.base/java.lang/String.class", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      ],
    });
    const res = await createLspDefinitionTool(providerStub(client)).handler({ file: FILE, line: 1, character: 1 });

    expect(res.isError).toBeFalsy();
    const text = structuredBlock(res.modelContent).text;
    expect(text).toContain("Found 2 definition(s)");
    expect(text).toContain("/repo/src/a.ts:10:5");
    expect(text).toContain("jdt://contents/java.base/java.lang/String.class:1:1");
  });

  it("keeps a reference whose URI is a file: spelling without a leading slash", async () => {
    const client = fakeClient({
      references: [
        { uri: "file://repo/src/a.ts", range: zeroRange },
        { uri: "jdt://ref/foreign.class", range: zeroRange },
      ],
    });
    const res = await createLspReferencesTool(providerStub(client)).handler({ file: FILE, line: 1, character: 1 });

    expect(res.isError).toBeFalsy();
    const text = structuredBlock(res.modelContent).text;
    expect(text).toContain("Found 2 reference(s)");
    expect(text).toContain("/repo/src/a.ts:1:1");
    expect(text).toContain("jdt://ref/foreign.class");
  });

  it("renders a rename target with a foreign scheme verbatim and still counts it", async () => {
    const client = fakeClient({
      rename: {
        "file:///repo/src/a.ts": [{ range: zeroRange }],
        "jdt://rename/foreign.class": [{ range: zeroRange }],
      },
    });
    const res = await createLspRenameTool(providerStub(client)).handler({ file: FILE, line: 1, character: 1, newName: "x" });

    expect(res.isError).toBeFalsy();
    expect(res.modelContent).toContain("across 2 file(s)");
    expect(res.modelContent).toContain("/repo/src/a.ts: 1 edit(s)");
    expect(res.modelContent).toContain("jdt://rename/foreign.class: 1 edit(s)");
  });

  it("decodes encoded references and rename targets too", async () => {
    const references = createLspReferencesTool(
      providerStub(fakeClient({ references: [{ uri: "file:///tmp/%E4%B8%AD%E6%96%87/r.ts", range: zeroRange }] })),
    );
    const refResult = await references.handler({ file: FILE, line: 1, character: 1 });
    expect(structuredBlock(refResult.modelContent).text).toContain("/tmp/中文/r.ts");

    const rename = createLspRenameTool(
      providerStub(fakeClient({ rename: { "file:///tmp/%E4%B8%AD%E6%96%87/n.ts": [{ range: zeroRange }] } })),
    );
    expect((await rename.handler({ file: FILE, line: 1, character: 1, newName: "x" })).modelContent).toContain(
      "/tmp/中文/n.ts",
    );
  });
});

describe("F-112/LSP error mapping", () => {
  it("an escaping path is an actionable isError and no request is sent", async () => {
    const client = fakeClient();
    const res = await createLspDefinitionTool(
      failingProvider("LSP_PATH_OUTSIDE_WORKSPACE", '"../../etc/passwd" resolves outside the workspace root /repo'),
    ).handler({ file: "../../etc/passwd", line: 1, character: 1 });

    expect(res.isError).toBe(true);
    expect(res.modelContent).toContain("LSP_PATH_OUTSIDE_WORKSPACE");
    expect(res.modelContent).toContain("workspace");
    expect(client.calls).toHaveLength(0);
  });

  it("renders manager errors as isError results, never throwing", async () => {
    const res = await createLspHoverTool(failingProvider("LSP_UNAVAILABLE", "language server died")).handler({
      file: FILE,
      line: 1,
      character: 1,
    });
    expect(res.isError).toBe(true);
    expect(res.modelContent).toContain("language server died");
  });

  it("quotes LSP_SERVER_MISSING with install guidance", async () => {
    const res = await createLspDefinitionTool(
      failingProvider("LSP_SERVER_MISSING", 'language server "typescript-language-server" was not found'),
    ).handler({ file: FILE, line: 1, character: 1 });

    expect(res.isError).toBe(true);
    expect(res.modelContent).toContain("LSP_SERVER_MISSING");
    expect(res.modelContent).toContain("npm install -g typescript-language-server typescript");
    // Spec §4.6: the loader reads this path, not a workspace `lsp.json`.
    expect(res.modelContent).toContain("~/.volto/lsp.json");
  });

  it("quotes LSP_LANGUAGE_UNCONFIGURED with a copy-pasteable config snippet", async () => {
    const res = await createLspDiagnosticsTool(
      failingProvider("LSP_LANGUAGE_UNCONFIGURED", 'no language server configured for "python"'),
    ).handler({ file: "/repo/src/a.py" });

    expect(res.isError).toBe(true);
    expect(res.modelContent).toContain("LSP_LANGUAGE_UNCONFIGURED");
    expect(res.modelContent).toContain('"python":');
    expect(res.modelContent).toContain('"args"');
    expect(res.modelContent).toContain("~/.volto/lsp.json");
  });

  it("quotes LSP_PATH_OUTSIDE_WORKSPACE with the workspace boundary rule", async () => {
    const res = await createLspHoverTool(
      failingProvider("LSP_PATH_OUTSIDE_WORKSPACE", '"../etc/passwd" is outside the workspace root /repo'),
    ).handler({ file: "../etc/passwd", line: 1, character: 1 });

    expect(res.isError).toBe(true);
    expect(res.modelContent).toContain("LSP_PATH_OUTSIDE_WORKSPACE");
    expect(res.modelContent).toContain("workspace");
  });

  it("covers every manager code so no failure path is unmapped", () => {
    for (const code of LSP_ERROR_CODES) {
      expect(LSP_ERROR_TEXT[code]).toBeDefined();
    }
  });

  it("formatLspError keeps the code and the actionable tail", () => {
    const text = formatLspError(managerError("LSP_SERVER_MISSING", "was not found"));
    expect(text).toContain("LSP_SERVER_MISSING");
    expect(text).toContain("was not found");
    expect(text).toContain("install");
  });
});

describe("lsp_diagnostics", () => {
  it("returns structured diagnostics with a 1-based location and a source-aware summary", async () => {
    const client = fakeClient(
      {},
      {
        source: "push",
        diagnostics: [
          {
            range: { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } },
            severity: "error",
            message: "Type mismatch",
          },
          {
            range: { start: { line: 10, character: 0 }, end: { line: 10, character: 5 } },
            severity: "warning",
            message: "Unused import",
          },
        ],
      },
    );
    const tool = createLspDiagnosticsTool(providerStub(client));
    const result = await tool.handler({ file: FILE });

    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("1 error");
    expect(result.modelContent).toContain("1 warning");
    expect(result.modelContent).toContain("2 total");
    expect(result.modelContent).toContain("Type mismatch");
    // The report's provenance is carried through to the model.
    expect(text(result.modelContent).toLowerCase()).toContain("push");
    expect(result.displayMetadata).toMatchObject({ source: "push", file: FILE });
  });

  it("F-112 renders 'reported and empty' with the spec's parseable counts, not prose", async () => {
    const client = fakeClient({}, { source: "push", diagnostics: [] });
    const tool = createLspDiagnosticsTool(providerStub(client));

    const reported = await tool.handler({ file: FILE });
    expect(reported.isError).toBeFalsy();
    // Spec §5.2 fixes this literal form for the reported-and-empty state.
    expect(text(reported.modelContent)).toContain("0 error(s), 0 warning(s)");
    expect(text(reported.modelContent)).toContain("0 total");
    expect(text(reported.modelContent).toLowerCase()).not.toContain("indexing");

    // Mutate the object the stub already holds; reassigning the property would
    // leave the closure reading the value it captured at construction.
    client.publish.source = "none";
    const unreported = await tool.handler({ file: FILE });
    expect(unreported.isError).toBeFalsy();
    expect(text(unreported.modelContent).toLowerCase()).toContain("has not reported");
    expect(text(unreported.modelContent).toLowerCase()).toContain("indexing");
    expect(unreported.modelContent).not.toBe(reported.modelContent);
  });

  it("F-112 renders a pulled empty report with the same counts and no indexing caveat", async () => {
    const client = fakeClient({}, { source: "pull", diagnostics: [] });
    const result = await createLspDiagnosticsTool(providerStub(client)).handler({ file: FILE });

    expect(result.isError).toBeFalsy();
    expect(text(result.modelContent)).toContain("0 error(s), 0 warning(s)");
    expect(text(result.modelContent)).toContain("0 total");
    expect(text(result.modelContent)).toContain("pull");
    expect(text(result.modelContent).toLowerCase()).not.toContain("indexing");
    expect(result.displayMetadata).toMatchObject({ source: "pull" });
  });

  it("never renders 'no diagnostics' for an empty array without consulting source", async () => {
    const client = fakeClient({}, { source: "none", diagnostics: [] });
    const result = await createLspDiagnosticsTool(providerStub(client)).handler({ file: FILE });
    // The old implementation keyed its text off `diagnostics.length` alone.
    expect(result.modelContent).not.toContain("No diagnostics for");
  });

  it("truncates long diagnostic lists and says how many were left out", async () => {
    const diagnostics: LspDiagnostic[] = Array.from({ length: 25 }, (_, index) => ({
      range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } },
      severity: "error" as const,
      message: `problem ${index}`,
    }));
    const client = fakeClient({}, { source: "pull", diagnostics });
    const result = await createLspDiagnosticsTool(providerStub(client)).handler({ file: FILE });

    expect(result.modelContent).toContain("25 error");
    expect(result.modelContent).toContain("problem 19");
    expect(result.modelContent).not.toContain("problem 20");
    expect(result.modelContent).toContain("and 5 more");
  });
});

describe("lsp_hover", () => {
  it("returns hover contents", async () => {
    const client = fakeClient({ hover: { contents: "```typescript\nfunction greet(name: string): void\n```" } });
    const tool = createLspHoverTool(providerStub(client));
    const result = await tool.handler({ file: FILE, line: 1, character: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("function greet");
  });

  it("returns no hover message when null", async () => {
    const tool = createLspHoverTool(providerStub(fakeClient({ hover: null })));
    const result = await tool.handler({ file: FILE, line: 1, character: 1 });
    expect(result.modelContent).toContain("No hover");
  });

  it("F-120 converts the position to 0-based before the call", async () => {
    const client = fakeClient({ hover: { contents: "hover text" } });
    await createLspHoverTool(providerStub(client)).handler({ file: FILE, line: 1, character: 1 });
    expect(client.calls[0]).toMatchObject({ method: "hover", line: 0, character: 0 });
  });
});
