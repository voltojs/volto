/**
 * Reference CLI — minimal host application.
 *
 * This is the reference implementation of how a host wires up the agent core.
 * It does ONLY wiring: injects adapters, subscribes to events, and renders
 * output to stdout. The core package is never modified.
 */

import { createAgent } from "@agent-core/sdk";
import type { EventSink } from "@agent-core/core";
import { createOpenAIModelPort } from "@agent-core/provider-openai";
import {
  createNodeFileSystem,
  createNodeShell,
  createNodeNetwork,
} from "@agent-core/runtime-node";
import { createWriteTodosTool } from "@agent-core/tools-plan";

// ── Config from environment ──
const MODEL = process.env["AGENT_MODEL"] ?? "gpt-4o";
const API_KEY = process.env["OPENAI_API_KEY"] ?? "";
const BASE_URL = process.env["OPENAI_BASE_URL"];
const CWD = process.env["AGENT_CWD"] ?? process.cwd();

// ── Validate ──
if (!API_KEY) {
  process.stderr.write(
    "Error: OPENAI_API_KEY is required.\n" +
    "Usage: AGENT_MODEL=gpt-4o OPENAI_API_KEY=sk-... node dist/main.js\n",
  );
  process.exit(1);
}

// ── Stdout event sink (streaming render) ──
const stdoutEventSink: EventSink = {
  emit(event) {
    if (event.type === "text_delta") {
      process.stdout.write(event.data["text"] as string);
    } else if (event.type === "model_done") {
      process.stdout.write("\n");
    }
  },
};

// ── Assemble adapters ──
const fs = createNodeFileSystem({ root: CWD });
const shell = createNodeShell({ defaultCwd: CWD });
const network = createNodeNetwork();
const modelPort = createOpenAIModelPort({
  apiKey: API_KEY,
  baseURL: BASE_URL,
  defaultModel: MODEL,
});

// ── Create the agent (SDK wiring) ──
// Adapter-backed tools (fs/shell/web) are auto-created by the SDK.
// Only custom tools need to be passed explicitly.
const agent = createAgent({
  modelPort,
  model: MODEL,
  fs,
  shell,
  network,
  cwd: CWD,
  eventSink: stdoutEventSink,
  tools: [createWriteTodosTool()],
  enableTaskTool: true,
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
