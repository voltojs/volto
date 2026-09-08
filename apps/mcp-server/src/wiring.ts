/**
 * Agent wiring for MCP server.
 * Reuses the same pattern as headless-server.
 */

import { createAgent } from "@volto/sdk";
import { createPiAiModelPort } from "@volto/provider-pi-ai";
import {
  createNodeFileSystem,
  createNodeShell,
  createNodeNetwork,
} from "@volto/runtime-node";
import { createStore as createSqliteStore } from "@volto/store-sqlite";
import type { ModelPort, EventSink } from "@volto/core";

export interface WiringOptions {
  modelPort?: ModelPort;
  eventSink?: EventSink;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  cwd?: string;
  dbPath?: string;
}

export function createWiredAgent(opts: WiringOptions = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const dbPath = opts.dbPath ?? "./mcp-sessions.db";

  const fs = createNodeFileSystem({ root: cwd });
  const shell = createNodeShell({ defaultCwd: cwd });
  const network = createNodeNetwork();
  const model = opts.model ?? process.env["OPENAI_MODEL"] ?? "gpt-4o";
  const modelPort = opts.modelPort ?? createPiAiModelPort({
    providers: [
      {
        kind: "custom",
        id: "default",
        // Mirrors provider-openai's own default when no baseURL is given.
        baseURL: opts.baseUrl ?? process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com",
        apiKey: opts.apiKey ?? process.env["OPENAI_API_KEY"] ?? "",
        models: [{ code: model }],
      },
    ],
    defaultProviderId: "default",
    defaultModel: model,
  });
  const sessionStore = createSqliteStore({ path: dbPath });

  return createAgent({
    modelPort,
    model: opts.model ?? process.env["OPENAI_MODEL"] ?? "gpt-4o",
    fs,
    shell,
    network,
    sessionStore,
    eventSink: opts.eventSink,
    enableTaskTool: true,
  });
}
