/**
 * Agent wiring for MCP server.
 * Reuses the same pattern as headless-server.
 */

import { createAgent } from "@agent-core/sdk";
import { createOpenAIModelPort } from "@agent-core/provider-openai";
import {
  createNodeFileSystem,
  createNodeShell,
  createNodeNetwork,
} from "@agent-core/runtime-node";
import { createStore as createSqliteStore } from "@agent-core/store-sqlite";
import type { ModelPort, EventSink } from "@agent-core/core";

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
  const modelPort = opts.modelPort ?? createOpenAIModelPort({
    apiKey: opts.apiKey ?? process.env["OPENAI_API_KEY"] ?? "",
    baseURL: opts.baseUrl ?? process.env["OPENAI_BASE_URL"],
    defaultModel: opts.model ?? process.env["OPENAI_MODEL"] ?? "gpt-4o",
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
