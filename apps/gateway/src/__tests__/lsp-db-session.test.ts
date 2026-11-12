import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMockModelPort,
  extractBlockText,
  textScript,
  toolCallScript,
} from "@volto/core";
import type { ContentBlock, ModelEvent, ModelPort, ModelRequest } from "@volto/core";
import { probeBinary } from "@volto/runtime-node";
import {
  buildSandboxConfigs,
  createWiredAgent,
  SECRET_ENV_PATTERNS,
} from "../wiring.js";
import {
  buildPermissionConfig,
  sandboxModeFor,
  type UiPermissionMode,
} from "../permission-modes.js";

/**
 * F-123 — the acceptance core: a REAL session built through the gateway
 * wiring, asserted on the tool list the model actually receives.
 *
 * Nothing here stubs the LSP manager or the sqlite opener: `createWiredAgent`
 * builds both from `~/.volto/lsp.json` (redirected to a temp dir) and the
 * session's sandbox mode, exactly as a production session does. The positive
 * LSP case points the configured `command` at the runtime package's LSP fixture
 * — a real child process over real stdio pipes — so the suite never depends on
 * a machine-installed language server.
 *
 * F-168 (toolset governance): since the SDK default now trims the visible set
 * to 20 with a floor table, these cases pin WIRING/ASSEMBLY intent — all five
 * lsp_* tools and db_query offered, no governance assertions — so every
 * session built in this file opts out of the cap explicitly via the D5 escape
 * hatch (`toolVisibility: { limit: Infinity }`). The gateway's WiringOptions
 * has no toolVisibility passthrough (production code is out of scope here),
 * so the escape hatch is injected at the agent-construction seam by wrapping
 * the real createAgent. Governance semantics themselves are pinned by
 * toolset-governance-session.test.ts.
 */
vi.mock("@volto/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@volto/sdk")>();
  return {
    ...actual,
    createAgent: (opts: Parameters<typeof actual.createAgent>[0]) =>
      actual.createAgent({ ...opts, toolVisibility: { limit: Infinity } }),
  };
});

/** The Task 2 fixture, spawned as the configured language server. */
const LSP_FIXTURE = fileURLToPath(
  new URL(
    "../../../../packages/runtimes/node/src/__tests__/fixtures/lsp-server.mjs",
    import.meta.url,
  ),
);

/** Repo root, for the real-language-server smoke test. */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

let tempConfigDir: string;
let tempProjectDir: string;
let tempHomeDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
  tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-lsp-session-config-"));
  tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-lsp-session-project-"));
  tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-lsp-session-home-"));
  originalConfigDir = process.env["VOLTO_CONFIG_DIR"];
  process.env["VOLTO_CONFIG_DIR"] = tempConfigDir;
  originalHome = process.env["HOME"];
  process.env["HOME"] = tempHomeDir;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env["VOLTO_CONFIG_DIR"];
  else process.env["VOLTO_CONFIG_DIR"] = originalConfigDir;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  await fs.rm(tempConfigDir, { recursive: true, force: true });
  await fs.rm(tempProjectDir, { recursive: true, force: true });
  await fs.rm(tempHomeDir, { recursive: true, force: true });
});

async function writeLspConfig(value: unknown): Promise<void> {
  await fs.writeFile(path.join(tempConfigDir, "lsp.json"), JSON.stringify(value), "utf-8");
}

function captureModelPort(scripts: ModelEvent[][]): {
  modelPort: ModelPort;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  const inner = createMockModelPort(scripts);
  return {
    requests,
    modelPort: {
      async *stream(req) {
        requests.push(req);
        yield* inner.stream(req);
      },
    },
  };
}

/** The tool-result text the model saw on the request at `index`. */
function toolResultText(requests: ModelRequest[], index = 1): string {
  const messages = requests[index]?.messages ?? [];
  const blocks: ContentBlock[] = messages.flatMap((m) => (m.role === "tool" ? m.content : []));
  return blocks
    .filter((block) => block.type === "tool_result")
    .map((block) => extractBlockText(block))
    .join("\n");
}

/**
 * Build one real session the way `sessions.ts` does: the preset chooses both
 * the sandbox boundary and the approval policy, and the preset's sandbox mode
 * is what wiring turns into `allowWrite`.
 */
async function buildSession(
  permissionMode: UiPermissionMode,
  modelPort: ModelPort,
): Promise<Awaited<ReturnType<typeof createWiredAgent>>> {
  return createWiredAgent({
    modelPort,
    cwd: tempProjectDir,
    permissionMode,
    sandboxMode: sandboxModeFor(permissionMode),
    permissionConfig: buildPermissionConfig(permissionMode),
  });
}

/** Run one text-only turn and return the tool names the model was offered. */
async function sessionToolNames(permissionMode: UiPermissionMode): Promise<string[]> {
  const { modelPort, requests } = captureModelPort([textScript("ok")]);
  const agent = await buildSession(permissionMode, modelPort);
  try {
    await agent.run("which tools do you have?");
    return requests[0]!.tools.map((tool) => tool.name);
  } finally {
    await agent.dispose();
  }
}

const LSP_TOOLS = [
  "lsp_definition",
  "lsp_references",
  "lsp_rename",
  "lsp_diagnostics",
  "lsp_hover",
] as const;

describe("F-123 real session tool visibility through the gateway wiring", () => {
  it("exposes the five lsp_* tools and db_query on a writable session", async () => {
    await writeLspConfig({ servers: {} });
    const tools = await sessionToolNames("full");
    expect(tools).toEqual(expect.arrayContaining([...LSP_TOOLS, "db_query"]));
    // Positive baseline for the confining case below: a writable session that
    // resolves a SQLite opener also offers the write tool.
    expect(tools).toContain("db_exec");
  });

  it("plan and read-only sessions never see db_exec", async () => {
    // Pure SDK capability gating: no sandbox backend is involved, so this must
    // never be gated on one (a host without a confining backend would silently
    // skip the acceptance core's capability half).
    await writeLspConfig({ servers: {} });

    const planned = await sessionToolNames("plan");
    expect(planned).not.toContain("db_exec");
    expect(planned).toEqual(expect.arrayContaining([...LSP_TOOLS, "db_query"]));

    const readOnly = await sessionToolNames("read-only");
    expect(readOnly).not.toContain("db_exec");
    expect(readOnly).toEqual(expect.arrayContaining([...LSP_TOOLS, "db_query"]));
  });

  it("refuses the build on a malformed lsp.json instead of starting without LSP", async () => {
    await fs.writeFile(path.join(tempConfigDir, "lsp.json"), "{ not json", "utf-8");
    const { modelPort } = captureModelPort([textScript("ok")]);
    await expect(createWiredAgent({ modelPort, cwd: tempProjectDir })).rejects.toThrow(/lsp\.json/);
  });

  it("refuses the build on a malformed lsp.json entry", async () => {
    await writeLspConfig({ servers: { typescript: { comand: "typescript-language-server" } } });
    const { modelPort } = captureModelPort([textScript("ok")]);
    await expect(createWiredAgent({ modelPort, cwd: tempProjectDir })).rejects.toThrow(/lsp\.json/);
  });

  it("keeps the tools wired for an empty servers map and answers with configuration guidance", async () => {
    await writeLspConfig({ servers: {} });
    await fs.mkdir(path.join(tempProjectDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tempProjectDir, "src", "example.ts"),
      "export const answer = 42;\n",
      "utf-8",
    );

    const { modelPort, requests } = captureModelPort([
      toolCallScript(
        "call-1",
        "lsp_hover",
        JSON.stringify({ file: "src/example.ts", line: 1, character: 1 }),
      ),
      textScript("done"),
    ]);
    const agent = await createWiredAgent({ modelPort, cwd: tempProjectDir });
    try {
      await agent.run("hover the first line");

      const tools = requests[0]!.tools.map((tool) => tool.name);
      expect(tools).toEqual(expect.arrayContaining([...LSP_TOOLS, "db_query"]));

      const result = toolResultText(requests);
      expect(result).toContain("LSP_LANGUAGE_UNCONFIGURED");
      expect(result).toContain("No language server is configured for this file's language");
      expect(result).toContain("lsp.json");
    } finally {
      await agent.dispose();
    }
  });

  it("F-003 answers a configured session's lsp_hover through a real child process", async () => {
    await writeLspConfig({
      servers: { typescript: { command: process.execPath, args: [LSP_FIXTURE] } },
    });
    await fs.mkdir(path.join(tempProjectDir, "src"), { recursive: true });
    const source = "export const answer = 42;\n";
    await fs.writeFile(path.join(tempProjectDir, "src", "example.ts"), source, "utf-8");

    const { modelPort, requests } = captureModelPort([
      toolCallScript(
        "call-1",
        "lsp_hover",
        JSON.stringify({ file: "src/example.ts", line: 1, character: 1 }),
      ),
      textScript("done"),
    ]);
    const agent = await createWiredAgent({ modelPort, cwd: tempProjectDir });
    try {
      await agent.run("hover the first line");

      const result = toolResultText(requests);
      expect(result).not.toContain("lsp_hover failed");
      // The fixture only answers after the manager's `didOpen`, and its answer
      // echoes the document length it read through the session FileSystem —
      // one assertion covers spawn, handshake, document sync and result flow.
      expect(result).toContain("fixture hover");
      expect(result).toContain(`len=${source.length}`);
    } finally {
      await agent.dispose();
    }
  }, 30_000);
});

describe("buildSandboxConfigs — the LSP child sandbox is the fs side, never the shell side", () => {
  it("strips secret-shaped env vars and keeps egress denied while retaining the credential dir", () => {
    const { fsConfig, shellConfig, lspConfig } = buildSandboxConfigs("workspace-write", "/workspace", [
      "/credentials",
    ]);

    expect(fsConfig).not.toBeNull();
    expect(shellConfig).not.toBeNull();
    expect(lspConfig).not.toBeNull();

    // Derived from the fs side: same mode / roots / denied reads.
    expect(lspConfig).toEqual({
      ...fsConfig,
      strippedEnvPatterns: expect.any(Array) as unknown as RegExp[],
    });
    expect(lspConfig?.deniedReadPaths).toEqual(["/credentials"]);

    // A third-party language-server binary must not inherit the gateway's
    // provider credentials.
    const patterns = lspConfig?.strippedEnvPatterns ?? [];
    expect(patterns).toHaveLength(SECRET_ENV_PATTERNS.length);
    expect(patterns.some((pattern) => pattern.test("OPENAI_API_KEY"))).toBe(true);

    // Never the shell config: egress stays at the spawner's deny default.
    expect(shellConfig?.network).toEqual({ enabled: true });
    expect(lspConfig?.network?.enabled).not.toBe(true);
    expect(lspConfig?.network).toBeUndefined();
  });

  it("is null when the session has no sandbox mode", () => {
    expect(buildSandboxConfigs(undefined, "/workspace", []).lspConfig).toBeNull();
  });
});

// ──────────────────────────────────────────────
// The closest honest proxy for manual items F-126 / F-127: the real
// `typescript-language-server`, on a real file in this repository, driven
// through a real session. Explicitly skipped when the binary is not installed
// — a skip is honest, a green assertion against a missing binary is not.
// ──────────────────────────────────────────────
const typescriptLanguageServerAvailable = probeBinary("typescript-language-server");
const itRealServer = typescriptLanguageServerAvailable ? it : it.skip;

/** 1-based line/character of `needle`'s first occurrence. */
function positionOf(source: string, needle: string): { line: number; character: number } {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`needle not found: ${needle}`);
  const before = source.slice(0, index);
  const lastNewline = before.lastIndexOf("\n");
  return { line: before.split("\n").length, character: index - lastNewline };
}

describe("F-126 / F-127 proxy — a real typescript-language-server session", () => {
  itRealServer(
    "resolves a definition to the same line read_file reports for the declaration",
    async () => {
      // A real file in this repository, queried through a real session. The
      // symbol is declared in the same file on purpose: go-to-definition
      // across a module boundary depends on which TS project the server
      // configures for the workspace, and what F-126 measures is that the
      // returned location matches `read_file`'s own line numbering.
      const targetFile = "apps/gateway/src/permission-modes.ts";
      const source = await fs.readFile(path.join(REPO_ROOT, targetFile), "utf-8");

      const usage = positionOf(source, "LEGACY_ALIASES, value");
      const declarationLine =
        source.split("\n").findIndex((line) => line.includes("const LEGACY_ALIASES")) + 1;
      expect(declarationLine).toBeGreaterThan(0);

      await writeLspConfig({
        servers: { typescript: { command: "typescript-language-server", args: ["--stdio"] } },
      });

      const { modelPort, requests } = captureModelPort([
        toolCallScript(
          "call-1",
          "lsp_definition",
          JSON.stringify({ file: targetFile, line: usage.line, character: usage.character }),
        ),
        textScript("done"),
      ]);
      const agent = await createWiredAgent({ modelPort, cwd: REPO_ROOT });
      try {
        await agent.run("where is LEGACY_ALIASES declared?");

        const result = toolResultText(requests);
        expect(result).not.toContain("lsp_definition failed");
        // The rendered location is `<path>:<1-based line>:<1-based character>`
        // — the same numbering `read_file` and the editor show.
        expect(result).toContain(`permission-modes.ts:${declarationLine}:`);
      } finally {
        await agent.dispose();
      }
    },
    90_000,
  );
});
