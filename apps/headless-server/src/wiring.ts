/**
 * Agent wiring for headless server.
 * Assembles adapters, provider, tools, and store into a createAgent call.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createAgent } from "@volto/sdk";
import { createOpenAIModelPort } from "@volto/provider-openai";
import {
  createNodeFileSystem,
  createNodeShell,
  createNodeNetwork,
} from "@volto/runtime-node";
import { createStore as createSqliteStore } from "@volto/store-sqlite";
import { expandInstructions, type ContextLayer } from "@volto/core";
import type { ModelPort, PermissionConfig, Message } from "@volto/core";
import { getConfigDir } from "./config/paths.js";

/** Reads one AGENTS.md file if it exists; returns undefined (not an error) if it doesn't. */
async function readAgentsFile(dir: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(dir, "AGENTS.md"), "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

/**
 * Builds this turn's static context layers: user-level AGENTS.md
 * (~/.volto/AGENTS.md) and project-level AGENTS.md (<cwd>/AGENTS.md), kept
 * as two separate ContextLayers (never merged) so a future audit sink can
 * tell which source contributed which text.
 */
async function resolveMemoryLayers(cwd: string): Promise<ContextLayer[]> {
  const layers: ContextLayer[] = [];
  const configDir = getConfigDir();

  const userRaw = await readAgentsFile(configDir);
  if (userRaw !== undefined) {
    const expanded = expandInstructions(new Map([["AGENTS.md", userRaw]]), "AGENTS.md", configDir);
    layers.push({ id: "user-memory", text: expanded.text });
  }

  const projectRaw = await readAgentsFile(cwd);
  if (projectRaw !== undefined) {
    const expanded = expandInstructions(new Map([["AGENTS.md", projectRaw]]), "AGENTS.md", cwd);
    layers.push({ id: "project-memory", text: expanded.text });
  }

  return layers;
}

export interface WiringOptions {
  modelPort?: ModelPort;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  cwd?: string;
  dbPath?: string;
  /** Permission policy for this agent instance. */
  permissionConfig?: PermissionConfig;
  /** Conversation history to seed when rebuilding an instance. */
  initialMessages?: Message[];
}

export function createWiredAgent(opts: WiringOptions = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const dbPath = opts.dbPath ?? "./headless-sessions.db";

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
    enableTaskTool: true,
    resolveContextLayers: (_input) => resolveMemoryLayers(cwd),
    ...(opts.permissionConfig ? { permissionConfig: opts.permissionConfig } : {}),
    ...(opts.initialMessages ? { initialMessages: opts.initialMessages } : {}),
  });
}
