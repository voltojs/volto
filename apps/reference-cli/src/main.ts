/**
 * Reference CLI — minimal host application.
 *
 * This is the reference implementation of how a host wires up the agent core.
 * It does ONLY wiring: injects adapters, subscribes to events, and renders
 * output to stdout. The core package is never modified.
 */

import { createAgent } from "@agent-core/sdk";
import { createDefaultPermissionConfig } from "@agent-core/core";
import { createOpenAIModelPort } from "@agent-core/provider-openai";
import {
  createNodeFileSystem,
  createNodeShell,
  createNodeNetwork,
  createNodeScheduler,
  createSqliteDatabaseAdapter,
  createNodeDocumentParser,
  createNodeBrowserAdapter,
  createNodeLspClient,
} from "@agent-core/runtime-node";
import { createWriteTodosTool } from "@agent-core/tools-plan";
import { createRenderingEventSink } from "./render.js";

// ── Config from environment ──
const MODEL = process.env["AGENT_MODEL"] ?? "gpt-4o";
const API_KEY = process.env["OPENAI_API_KEY"] ?? "";
const BASE_URL = process.env["OPENAI_BASE_URL"];
const CWD = process.env["AGENT_CWD"] ?? process.cwd();
const DB_FILE = process.env["AGENT_DB_FILE"];
const LSP_COMMAND = process.env["AGENT_LSP_COMMAND"];
const LSP_ARGS = process.env["AGENT_LSP_ARGS"]?.split(",") ?? [];
const ENABLE_DOCUMENT_PARSER = process.env["AGENT_DOCUMENT_PARSER"] === "true";
const ENABLE_BROWSER = process.env["AGENT_BROWSER"] === "true";
const PERMISSION_MODE = process.env["AGENT_PERMISSION_MODE"] ?? "auto-allow";

// ── Validate ──
if (!API_KEY) {
  process.stderr.write(
    "Error: OPENAI_API_KEY is required.\n" +
    "Usage: AGENT_MODEL=gpt-4o OPENAI_API_KEY=sk-... node dist/main.js\n",
  );
  process.exit(1);
}

// ── Stdout event sink (streaming render) ──
const stdoutEventSink = createRenderingEventSink({
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});

// ── Assemble core adapters ──
const fs = createNodeFileSystem({ root: CWD });
const shell = createNodeShell({ defaultCwd: CWD });
const network = createNodeNetwork();
const modelPort = createOpenAIModelPort({
  apiKey: API_KEY,
  baseURL: BASE_URL,
  defaultModel: MODEL,
});

// ── Scheduler (always enabled) ──
const clock = { now: () => Date.now() };
const scheduler = createNodeScheduler({ clock });

// ── Permission config ──
const permissionConfig = createDefaultPermissionConfig();
permissionConfig.mode = PERMISSION_MODE === "plan" ? "plan" : "auto-accept";

// ── Optional adapters (conditional via env vars) ──
let dbAdapter: Parameters<typeof createAgent>[0]["dbAdapter"];
if (DB_FILE) {
  try {
    dbAdapter = await createSqliteDatabaseAdapter({ filename: DB_FILE });
    process.stderr.write(`Database connected: ${DB_FILE}\n`);
  } catch (err) {
    process.stderr.write(
      `Warning: Could not load database adapter: ${err instanceof Error ? err.message : String(err)}\n` +
      "Install with: pnpm add better-sqlite3\n",
    );
  }
}

let documentParser: Parameters<typeof createAgent>[0]["documentParser"];
if (ENABLE_DOCUMENT_PARSER) {
  try {
    documentParser = await createNodeDocumentParser();
    process.stderr.write("Document parser enabled (pdf-parse/mammoth/xlsx)\n");
  } catch (err) {
    process.stderr.write(
      `Warning: Could not load document parser: ${err instanceof Error ? err.message : String(err)}\n` +
      "Install with: pnpm add pdf-parse mammoth xlsx\n",
    );
  }
}

let browserAdapter: Parameters<typeof createAgent>[0]["browserAdapter"];
if (ENABLE_BROWSER) {
  try {
    browserAdapter = await createNodeBrowserAdapter({ headless: true });
    process.stderr.write("Browser adapter enabled (Playwright)\n");
  } catch (err) {
    process.stderr.write(
      `Warning: Could not load browser adapter: ${err instanceof Error ? err.message : String(err)}\n` +
      "Install with: pnpm add playwright\n",
    );
  }
}

let lspClient: Parameters<typeof createAgent>[0]["lspClient"];
if (LSP_COMMAND) {
  try {
    lspClient = await createNodeLspClient({
      command: LSP_COMMAND,
      args: LSP_ARGS,
      cwd: CWD,
    });
    process.stderr.write(`LSP client connected: ${LSP_COMMAND}\n`);
  } catch (err) {
    process.stderr.write(
      `Warning: Could not start LSP server: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// ── Create the agent (SDK wiring) ──
const agent = createAgent({
  modelPort,
  model: MODEL,
  fs,
  shell,
  network,
  eventSink: stdoutEventSink,
  tools: [createWriteTodosTool()],
  enableTaskTool: true,
  scheduler,
  permissionConfig,
  dbAdapter,
  documentParser,
  browserAdapter,
  lspClient,
});

// ── REPL ──
async function repl(): Promise<void> {
  process.stderr.write(`Agent ready (model: ${MODEL}, cwd: ${CWD}). Type "exit" to quit.\n`);

  const rl = (await import("node:readline")).createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: "> ",
  });

  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    if (input === "exit" || input === "quit") {
      rl.close();
      process.exit(0);
    }

    try {
      await agent.run(input);
    } catch (err: unknown) {
      process.stderr.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

repl().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
