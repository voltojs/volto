/**
 * Wiring-level degradation: a missing optional capability must never stop the
 * gateway from starting, whether that capability is the sqlite driver, the
 * playwright browser host, or a language server binary.
 *
 * Nothing here depends on this machine's `node_modules`: the sqlite failure is
 * injected through `sessionStoreFactory`, the browser host is simply absent,
 * and the language server is pointed at a command that cannot exist.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createMockModelPort,
  extractBlockText,
  textScript,
  toolCallScript,
} from "@voltojs/core";
import type { ContentBlock, ModelPort, ModelRequest } from "@voltojs/core";
import { createWiredAgent } from "../wiring.js";

let configDir: string;
let projectDir: string;
let oldConfigDir: string | undefined;
let oldHome: string | undefined;

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-fallback-config-"));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-fallback-project-"));
  oldConfigDir = process.env["VOLTO_CONFIG_DIR"];
  oldHome = process.env["HOME"];
  process.env["VOLTO_CONFIG_DIR"] = configDir;
  process.env["HOME"] = configDir;
});

afterEach(async () => {
  delete process.env["VOLTO_SESSION_STORE"];
  if (oldConfigDir === undefined) delete process.env["VOLTO_CONFIG_DIR"];
  else process.env["VOLTO_CONFIG_DIR"] = oldConfigDir;
  if (oldHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = oldHome;
  await fs.rm(configDir, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
});

function captureModel(scripts: ReturnType<typeof textScript>[] = [textScript("ok")]): {
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

const BROWSER_TOOLS = ["browser_navigate", "browser_snapshot", "browser_click"];
const LSP_TOOLS = ["lsp_hover", "lsp_definition", "lsp_diagnostics"];

describe("wiring degradation when optional capabilities are missing", () => {
  it("a sqlite load failure starts the agent on the file store and never touches sessions.db", async () => {
    const dbPath = path.join(configDir, "db", "sessions.db");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.writeFile(dbPath, "precious", "utf-8");
    const before = await fs.stat(dbPath);
    const fallbacks: unknown[] = [];

    const { modelPort } = captureModel();
    const agent = await createWiredAgent({
      modelPort,
      cwd: projectDir,
      dbPath,
      sessionStoreFactory: {
        loadSqlite: async () => {
          throw new Error("Cannot find module 'better-sqlite3'");
        },
        onFallback: (err) => fallbacks.push(err),
      },
    });
    try {
      expect(agent.sessionStoreSelection.kind).toBe("file");
      // R25: a missing native module is its own class, distinct from a
      // database that exists but will not open.
      expect(agent.sessionStoreSelection.reason).toBe("module-missing");
      await agent.run("hi");
    } finally {
      await agent.dispose();
    }

    expect(fallbacks).toHaveLength(1);
    // The user-visible result: a file session actually persisted, elsewhere.
    const stored = await fs.readdir(path.join(configDir, "sessions-store"));
    expect(stored.filter((name) => name.endsWith(".json")).length).toBeGreaterThan(0);
    const after = await fs.stat(dbPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readFile(dbPath, "utf-8")).toBe("precious");
  });

  it("without a browser host the browser tools are absent and the agent still runs", async () => {
    const { modelPort, requests } = captureModel();
    const agent = await createWiredAgent({
      modelPort,
      cwd: projectDir,
      chatSessionId: "session-1",
      fallbackStoreDir: path.join(configDir, "sessions-store"),
    });
    try {
      await agent.run("hi");
    } finally {
      await agent.dispose();
    }
    const names = requests[0]!.tools.map((tool) => tool.name);
    for (const name of BROWSER_TOOLS) expect(names).not.toContain(name);
    expect(names.length).toBeGreaterThan(0);
  });

  it("a language server binary that is not installed fails the tool call, not the build or the loop", async () => {
    // `typescript-language-server` as an optionalDependency may be absent:
    // the binary then is not on PATH, which is what the manager probes.
    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        lsp: { servers: { typescript: { command: "volto-no-such-language-server" } } },
      }),
      "utf-8",
    );
    await fs.writeFile(path.join(projectDir, "a.ts"), "export const a = 1;\n", "utf-8");
    const { modelPort, requests } = captureModel([
      toolCallScript(
        "call-1",
        "lsp_hover",
        JSON.stringify({ file: "a.ts", line: 1, character: 1 }),
      ),
      textScript("done"),
    ]);
    const agent = await createWiredAgent({
      modelPort,
      cwd: projectDir,
      fallbackStoreDir: path.join(configDir, "sessions-store"),
    });
    try {
      // The build succeeded with LSP configured — the tools are offered, the
      // binary is probed only when a request needs it.
      await agent.run("hover a");
      const names = requests[0]!.tools.map((tool) => tool.name);
      // All five are offered: LSP without a browser must not be squeezed by
      // the plain 20-slot cap into a single lsp_* tool.
      expect(LSP_TOOLS.every((name) => names.includes(name))).toBe(true);
      // Same build, no browser host: the browser capability is absent.
      for (const name of BROWSER_TOOLS) expect(names).not.toContain(name);

      // The missing binary surfaces as an error result to the model, and the
      // turn goes on to its second request rather than throwing.
      expect(requests.length).toBeGreaterThanOrEqual(2);
      const result = toolResultText(requests);
      expect(result).toContain("LSP_SERVER_MISSING");
      expect(result).toContain("npm install -g typescript-language-server");
    } finally {
      await agent.dispose();
    }
  });
});