/**
 * Reference CLI — minimal host application.
 *
 * This is the reference implementation of how a host wires up the agent core.
 * It does ONLY wiring: injects adapters, subscribes to events, and renders
 * output to stdout. The core package is never modified.
 */

import { createAgent } from "@agent-core/sdk";
import { createDefaultPermissionConfig } from "@agent-core/core";
import type { EventSink } from "@agent-core/core";
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
  createFileAuditSink,
  InMemoryTelemetry,
} from "@agent-core/runtime-node";
import type { SandboxConfig } from "@agent-core/runtime-node";
import { createWriteTodosTool } from "@agent-core/tools-plan";
import { createRenderingEventSink } from "./render.js";
import { createTracingEventSink } from "./tracing-sink.js";

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

// ── Observability config (Layer 4 of E2E test pyramid) ──
const TRACE = process.env["AGENT_TRACE"] === "true";
const TRACE_FILE = process.env["AGENT_TRACE_FILE"];
const TRACE_INCLUDE = process.env["AGENT_TRACE_INCLUDE"]
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const AUDIT_FILE = process.env["AGENT_AUDIT_FILE"];
const TRACE_DUMP_TELEMETRY = process.env["AGENT_TRACE_TELEMETRY"] !== "false"; // default true when TRACE
const NO_COLOR = process.env["NO_COLOR"] !== undefined || !process.stderr.isTTY;

// ── Sandbox config (Plan 009) ──
const SANDBOX_MODE = process.env["AGENT_SANDBOX_MODE"];
const SANDBOX_ALLOW_HOSTS = process.env["AGENT_SANDBOX_ALLOW_HOSTS"];
let sandboxConfig: SandboxConfig | undefined;
if (SANDBOX_MODE === "read-only" || SANDBOX_MODE === "workspace-write" || SANDBOX_MODE === "danger-full-access") {
  sandboxConfig = {
    mode: SANDBOX_MODE,
    network: {
      enabled: false,
      ...(SANDBOX_ALLOW_HOSTS ? { enabled: true, allowedHosts: SANDBOX_ALLOW_HOSTS.split(",").map((h) => h.trim()).filter(Boolean) } : {}),
    },
  };
  process.stderr.write(`Sandbox enabled: mode=${SANDBOX_MODE}${SANDBOX_ALLOW_HOSTS ? `, allowedHosts=${SANDBOX_ALLOW_HOSTS}` : ""}\n`);
}

// ── Validate ──
if (!API_KEY) {
  process.stderr.write(
    "Error: OPENAI_API_KEY is required.\n" +
    "Usage: AGENT_MODEL=gpt-4o OPENAI_API_KEY=sk-... node dist/main.js\n",
  );
  process.exit(1);
}

// ── Stdout event sink (streaming render) ──
const renderingSink = createRenderingEventSink({
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});

// Optionally wrap with tracing for full-pipeline observability.
// Inner renderer still drives stdout; tracing decorates stderr + JSONL.
const stdoutEventSink: EventSink = TRACE
  ? createTracingEventSink({
      inner: renderingSink,
      write: (s) => process.stderr.write(s),
      ...(TRACE_INCLUDE ? { include: TRACE_INCLUDE } : {}),
      ...(TRACE_FILE ? { jsonlPath: TRACE_FILE } : {}),
      noColor: NO_COLOR,
    })
  : renderingSink;

if (TRACE) {
  process.stderr.write(
    `Tracing enabled${TRACE_FILE ? ` → ${TRACE_FILE}` : ""}` +
    `${TRACE_INCLUDE ? ` (filter: ${TRACE_INCLUDE.join(",")})` : ""}\n`,
  );
}

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

// ── Observability adapters (audit / telemetry) ──
const auditSink = AUDIT_FILE ? createFileAuditSink(AUDIT_FILE) : undefined;
if (AUDIT_FILE) {
  process.stderr.write(`Audit log → ${AUDIT_FILE}\n`);
}
const telemetry = TRACE ? new InMemoryTelemetry() : undefined;

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
  sandboxConfig,
  dbAdapter,
  documentParser,
  browserAdapter,
  lspClient,
  auditSink,
  telemetry,
});

// On exit (Ctrl-D, exit, quit), dump telemetry summary if tracing was on.
function dumpTelemetry(): void {
  if (!TRACE || !telemetry || !TRACE_DUMP_TELEMETRY) return;
  process.stderr.write("\n=== telemetry: spans ===\n");
  for (const span of telemetry.spans) {
    process.stderr.write(
      `  ${span.name}  ${JSON.stringify(span.attributes)}\n`,
    );
  }
  process.stderr.write("=== telemetry: metrics ===\n");
  for (const m of telemetry.metrics) {
    process.stderr.write(
      `  ${m.name}=${m.value}  ${JSON.stringify(m.attributes)}\n`,
    );
  }
  process.stderr.write(
    `=== summary: ${telemetry.spans.length} spans, ${telemetry.metrics.length} metrics ===\n`,
  );
}
process.on("exit", dumpTelemetry);

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
