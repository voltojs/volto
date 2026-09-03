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
import type { Skill } from "@volto/sdk";
import { findTriggeredSkills } from "@volto/sdk";
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
 * Recursively reads an instruction file and every file it @imports (transitively)
 * into a path->content map, so the pure expandInstructions() function can resolve
 * them without doing any I/O itself. A missing or unreadable imported file is
 * simply left out of the map — expandInstructions() already renders a
 * "[missing instruction file: ...]" placeholder for that case (that fallback is
 * a deliberate, tested part of its contract; this loader does not change it).
 */
async function loadInstructionFileTree(entryPath: string): Promise<Map<string, string>> {
  const fileContents = new Map<string, string>();
  const queue = [entryPath];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    let raw: string;
    try {
      raw = await fs.readFile(current, "utf-8");
    } catch {
      continue;
    }
    fileContents.set(current, raw);

    for (const line of raw.split("\n")) {
      const match = line.trim().match(/^@(.+)$/);
      if (!match?.[1]) continue;
      const importPath = match[1].startsWith("/")
        ? match[1]
        : path.join(path.dirname(current), match[1]);
      queue.push(importPath);
    }
  }

  return fileContents;
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
    const userPath = path.join(configDir, "AGENTS.md");
    const fileContents = await loadInstructionFileTree(userPath);
    const expanded = expandInstructions(fileContents, userPath, configDir);
    layers.push({ id: "user-memory", text: expanded.text });
  }

  const projectRaw = await readAgentsFile(cwd);
  if (projectRaw !== undefined) {
    const projectPath = path.join(cwd, "AGENTS.md");
    const fileContents = await loadInstructionFileTree(projectPath);
    const expanded = expandInstructions(fileContents, projectPath, cwd);
    layers.push({ id: "project-memory", text: expanded.text });
  }

  return layers;
}

interface ParsedSkillFile {
  name: string;
  description: string;
  trigger?: string;
  body: string;
}

/** Parses a SKILL.md file's `--- key: value ---` frontmatter plus body. Pure text processing. */
function parseSkillFile(raw: string): ParsedSkillFile | undefined {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return undefined;
  const [, frontmatter, body] = match;
  const fields: Record<string, string> = {};
  for (const line of frontmatter!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  if (!fields["name"] || !fields["description"]) return undefined;
  return { name: fields["name"], description: fields["description"], trigger: fields["trigger"], body: body!.trim() };
}

interface LoadedSkills {
  skills: Skill[];
  rootDirByResource: Map<string, string>;
}

/** Scans a skills directory (one subdirectory per skill, each containing SKILL.md) and loads them, tagging each skill's resource path with the rootDir @import expansion should use for it. */
async function loadSkillsFromDir(dir: string, rootDir: string): Promise<LoadedSkills> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { skills: [], rootDirByResource: new Map() };
  }
  const skills: Skill[] = [];
  const rootDirByResource = new Map<string, string>();
  for (const entry of entries) {
    const skillPath = path.join(dir, entry, "SKILL.md");
    try {
      const raw = await fs.readFile(skillPath, "utf-8");
      const parsed = parseSkillFile(raw);
      if (parsed) {
        skills.push({
          name: parsed.name,
          description: parsed.description,
          trigger: parsed.trigger,
          resources: [skillPath],
        });
        rootDirByResource.set(skillPath, rootDir);
      }
    } catch {
      // Not a skill directory (no SKILL.md) — skip.
    }
  }
  return { skills, rootDirByResource };
}

/** In-memory cache: skills directories are scanned once per agent instance, not once per turn. */
async function loadAllSkills(cwd: string): Promise<LoadedSkills> {
  const [userResult, projectResult] = await Promise.all([
    loadSkillsFromDir(path.join(getConfigDir(), "skills"), getConfigDir()),
    loadSkillsFromDir(path.join(cwd, ".volto", "skills"), cwd),
  ]);
  return {
    skills: [...userResult.skills, ...projectResult.skills],
    rootDirByResource: new Map([...userResult.rootDirByResource, ...projectResult.rootDirByResource]),
  };
}

/** Loads a skill's resource files (each already-expanded via @import) and joins them. */
async function loadSkillResourceText(skill: Skill, rootDirByResource: Map<string, string>): Promise<string> {
  const parts: string[] = [];
  for (const resourcePath of skill.resources ?? []) {
    const rootDir = rootDirByResource.get(resourcePath) ?? getConfigDir();
    const fileContents = await loadInstructionFileTree(resourcePath);
    const expanded = expandInstructions(fileContents, resourcePath, rootDir);
    // SKILL.md's own frontmatter isn't meant to be replayed into the model —
    // only the body after it. Re-parse to strip it.
    const parsed = parseSkillFile(expanded.text);
    parts.push(parsed ? parsed.body : expanded.text);
  }
  return parts.join("\n\n");
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

  let skillsPromise: Promise<LoadedSkills> | undefined;
  async function resolveContextLayers(input: string): Promise<ContextLayer[]> {
    const layers = await resolveMemoryLayers(cwd);
    skillsPromise ??= loadAllSkills(cwd);
    const { skills, rootDirByResource } = await skillsPromise;
    const triggered = findTriggeredSkills(skills, input);
    for (const skill of triggered) {
      const text = await loadSkillResourceText(skill, rootDirByResource);
      if (text) layers.push({ id: `skill:${skill.name}`, text });
    }
    return layers;
  }

  return createAgent({
    modelPort,
    model: opts.model ?? process.env["OPENAI_MODEL"] ?? "gpt-4o",
    fs,
    shell,
    network,
    sessionStore,
    enableTaskTool: true,
    resolveContextLayers,
    ...(opts.permissionConfig ? { permissionConfig: opts.permissionConfig } : {}),
    ...(opts.initialMessages ? { initialMessages: opts.initialMessages } : {}),
  });
}
