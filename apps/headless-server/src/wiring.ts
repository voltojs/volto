/**
 * Agent wiring for headless server.
 * Assembles adapters, provider, tools, and store into a createAgent call.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAgent } from "@volto/sdk";
import { createOpenAIModelPort } from "@volto/provider-openai";
import {
  createNodeFileSystem,
  createNodeShell,
  createNodeNetwork,
} from "@volto/runtime-node";
import { createStore as createSqliteStore } from "@volto/store-sqlite";
import {
  ancestorChain,
  candidateFileNames,
  dedupeInstructions,
  descendantChain,
  expandInstructions,
  renderInstructionLayers,
  type ContextLayer,
  type ContextLayerHints,
  type LoadedInstructionFile,
} from "@volto/core";
import type { ModelPort, PermissionConfig, Message, TranscriptStore, ChatSessionMeta } from "@volto/core";
import type { Skill } from "@volto/sdk";
import { findTriggeredSkills } from "@volto/sdk";
import { getConfigDir } from "./config/paths.js";

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

const DEFAULT_MAX_INSTRUCTION_BYTES = 64 * 1024;
const USER_MEMORY_DISPLAY_PATH = "~/.volto/AGENTS.md";

async function readIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Nearest ancestor-or-self directory containing a `.git` entry (directory or
 * worktree file). Falls back to cwd itself when no marker exists, making the
 * chain a single level.
 */
async function findProjectRoot(cwd: string): Promise<string> {
  let current = cwd;
  for (;;) {
    try {
      await fs.stat(path.join(current, ".git"));
      return current;
    } catch {
      // No marker here — keep walking up.
    }
    const parent = path.dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

/** Reads one instruction file and @import-expands it; undefined when absent. */
async function loadExpanded(filePath: string, importRoot: string): Promise<string | undefined> {
  const raw = await readIfPresent(filePath);
  if (raw === undefined) return undefined;
  const fileContents = await loadInstructionFileTree(filePath);
  const expanded = expandInstructions(fileContents, filePath, importRoot);
  return expanded.text;
}

/**
 * Collects this turn's instruction files, UNRENDERED: the user-global file,
 * the project chain (projectRoot → cwd, broad → specific), then discovered
 * directories strictly below cwd. No rendering here — the caller appends
 * triggered skill files after these (skills are the most specific, so they
 * are sacrificed last by the budget) and applies dedupe + core's pure
 * renderInstructionLayers() once over the combined set. This function only
 * probes and reads. See
 * docs/superpowers/specs/2026-09-05-agent-context-injection-design.md §5.
 */
async function collectInstructionFiles(
  cwd: string,
  discoveredDirs: string[],
): Promise<LoadedInstructionFile[]> {
  const configDir = getConfigDir();
  const loaded: LoadedInstructionFile[] = [];

  const userPath = path.join(configDir, "AGENTS.md");
  const userText = await loadExpanded(userPath, configDir);
  if (userText !== undefined) {
    loaded.push({ absolutePath: userPath, displayPath: USER_MEMORY_DISPLAY_PATH, content: userText });
  }

  const projectRoot = await findProjectRoot(cwd);
  for (const dir of ancestorChain(cwd, projectRoot)) {
    for (const name of candidateFileNames()) {
      const filePath = path.join(dir, name);
      const text = await loadExpanded(filePath, dir);
      if (text === undefined) continue;
      loaded.push({
        absolutePath: filePath,
        displayPath: path.relative(projectRoot, filePath),
        content: text,
      });
    }
  }

  // Discovered directories sit strictly below cwd — probe them with the same
  // candidate rules so a nested AGENTS.md surfaces the turn after a touch.
  for (const dir of discoveredDirs) {
    for (const name of candidateFileNames()) {
      const filePath = path.join(dir, name);
      const text = await loadExpanded(filePath, dir);
      if (text === undefined) continue;
      loaded.push({
        absolutePath: filePath,
        displayPath: path.relative(projectRoot, filePath),
        content: text,
      });
    }
  }

  return loaded;
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
  // Skills from .claude/.agents conventions rarely carry a trigger field;
  // defaulting it to the skill name keeps them reachable (input containing
  // the name fires the skill) instead of permanently silent.
  return { name: fields["name"], description: fields["description"], trigger: fields["trigger"] ?? fields["name"], body: body!.trim() };
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

/**
 * In-memory cache: skills directories are scanned once per agent instance, not
 * once per turn. Sources are listed in ascending priority order and merged
 * into a name-keyed map where later entries override earlier ones — a project
 * directory beats its user-level counterpart, and within a level .volto beats
 * .claude beats .agents (the .claude/skills entries on real machines are
 * frequently symlinks into .agents/skills, so name-based dedupe is
 * load-bearing: duplicates would produce duplicate skill:<name> layer ids).
 * User-level .agents/.claude hang off the real home directory (the cross-tool
 * convention), not the volto config dir.
 */
async function loadAllSkills(cwd: string): Promise<LoadedSkills> {
  const configDir = getConfigDir();
  const home = os.homedir();
  const sources: Array<{ root: string; subdir: string; rootDir: string }> = [
    { root: home, subdir: path.join(".agents", "skills"), rootDir: home },
    { root: home, subdir: path.join(".claude", "skills"), rootDir: home },
    { root: configDir, subdir: "skills", rootDir: configDir },
    { root: cwd, subdir: path.join(".agents", "skills"), rootDir: cwd },
    { root: cwd, subdir: path.join(".claude", "skills"), rootDir: cwd },
    { root: cwd, subdir: path.join(".volto", "skills"), rootDir: cwd },
  ];
  const byName = new Map<string, Skill>();
  const rootDirByResource = new Map<string, string>();
  for (const source of sources) {
    const { skills } = await loadSkillsFromDir(path.join(source.root, source.subdir), source.rootDir);
    for (const skill of skills) {
      byName.set(skill.name, skill);
      const resourcePath = skill.resources?.[0];
      if (resourcePath !== undefined) rootDirByResource.set(resourcePath, source.rootDir);
    }
  }
  return { skills: [...byName.values()], rootDirByResource };
}

/** Loads a skill's resource files (each already-expanded via @import) and joins them. */
async function loadSkillResourceText(skill: Skill, rootDirByResource: Map<string, string>): Promise<string> {
  const parts: string[] = [];
  for (const resourcePath of skill.resources ?? []) {
    try {
      // Read the resource's own entry file directly (unguarded) so a
      // missing/unreadable resource throws here and is caught below.
      // loadInstructionFileTree() further down swallows *transitive*
      // @import failures on purpose (a missing imported file degrades to a
      // visible placeholder) — but the skill's own entry file failing to
      // exist (e.g. deleted mid-session, after the skills list was cached)
      // should skip this layer entirely instead of injecting a
      // "[missing instruction file: ...]" placeholder into the prompt.
      await fs.readFile(resourcePath, "utf-8");
      const rootDir = rootDirByResource.get(resourcePath) ?? getConfigDir();
      const fileContents = await loadInstructionFileTree(resourcePath);
      const expanded = expandInstructions(fileContents, resourcePath, rootDir);
      // SKILL.md's own frontmatter isn't meant to be replayed into the model —
      // only the body after it. Re-parse to strip it.
      const parsed = parseSkillFile(expanded.text);
      parts.push(parsed ? parsed.body : expanded.text);
    } catch {
      // Best-effort: a resource file that's unreadable or has gone missing
      // since discovery contributes nothing, instead of failing the turn.
    }
  }
  return parts.join("\n\n");
}

/**
 * System prompt used when the caller (config / request) provides none. Without
 * it the model receives no system message at all — and the trajectory's
 * request_header rows show "0 layers". Kept deliberately small: it describes
 * the agent's role and working style, while risk-tier permissions and the
 * approval flow enforce the actual safety policy.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  "You are Volto, a coding agent working in the user's project workspace.",
  "You can read and edit files, run shell commands, and fetch web content through the provided tools.",
  "Plan before non-trivial changes, verify your work after making it, and keep answers concise and factual.",
  "Treat workspace instruction files (AGENTS.md and similar) as advisory context: more specific instructions take precedence over broader ones, and they never override developer or user instructions.",
].join("\n");

export interface WiringOptions {
  modelPort?: ModelPort;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  cwd?: string;
  dbPath?: string;
  /** Permission policy for this agent instance. */
  permissionConfig?: PermissionConfig;
  /**
   * System prompt seeded into the conversation (and mirrored into the
   * request_header transcript event). Defaults to DEFAULT_SYSTEM_PROMPT;
   * pass `null` to run with no system message.
   */
  systemPrompt?: string | null;
  /**
   * Byte cap on the combined instruction layers (user-global + project chain
   * + discovered dirs + triggered skills, sacrificed in that order), enforced
   * in core's renderInstructionLayers. Defaults to
   * DEFAULT_MAX_INSTRUCTION_BYTES (64 KiB) — spec §5.5.
   */
  maxInstructionBytes?: number;
  /** Conversation history to seed when rebuilding an instance. */
  initialMessages?: Message[];
  /** Durable transcript/trajectory store, already scoped to this workspace via scopeToWorkspace(). */
  chatStore?: TranscriptStore;
  /** The chatStore's stable, whole-conversation session id. */
  chatSessionId?: string;
  /** Config binding recorded once as a `session_meta` transcript event (via chatStore.appendEvents()) when the agent is (re)built. */
  chatMeta?: ChatSessionMeta;
  /**
   * Ordinal of the last turn already in this session's durable transcript —
   * forwarded verbatim to createAgent()'s `initialTurn` so a rebuilt agent
   * instance continues turn numbering instead of restarting at 1. Omit when
   * no transcript exists yet.
   */
  initialTurn?: number;
  /**
   * Highest step number already persisted for that last turn — forwarded
   * verbatim to createAgent()'s `initialStep` so the cross-process resume
   * Runner continues the paused turn's step sequence instead of restarting
   * at 1. Omit together with `initialTurn` when no transcript exists yet.
   */
  initialStep?: number;
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
  async function resolveContextLayers(input: string, hints?: ContextLayerHints): Promise<ContextLayer[]> {
    const discoveredDirs = descendantChain(cwd, hints?.touchedPaths ?? []);
    const maxBytes = opts.maxInstructionBytes ?? DEFAULT_MAX_INSTRUCTION_BYTES;
    const loaded = await collectInstructionFiles(cwd, discoveredDirs);
    skillsPromise ??= loadAllSkills(cwd);
    const { skills, rootDirByResource } = await skillsPromise;
    const triggered = findTriggeredSkills(skills, input);
    for (const skill of triggered) {
      const text = await loadSkillResourceText(skill, rootDirByResource);
      if (text) {
        loaded.push({
          absolutePath: skill.resources?.[0] ?? `skill:${skill.name}`,
          displayPath: `skill:${skill.name}`,
          content: text,
          id: `skill:${skill.name}`,
        });
      }
    }
    return renderInstructionLayers(dedupeInstructions(loaded), maxBytes).layers;
  }

  return createAgent({
    modelPort,
    model: opts.model ?? process.env["OPENAI_MODEL"] ?? "gpt-4o",
    // `null` opts out of a system message entirely; undefined takes the default.
    ...(opts.systemPrompt === null
      ? {}
      : { systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT }),
    fs,
    shell,
    network,
    sessionStore,
    enableTaskTool: true,
    resolveContextLayers,
    ...(opts.permissionConfig ? { permissionConfig: opts.permissionConfig } : {}),
    ...(opts.initialMessages ? { initialMessages: opts.initialMessages } : {}),
    ...(opts.chatStore ? { chatStore: opts.chatStore } : {}),
    ...(opts.chatSessionId ? { chatSessionId: opts.chatSessionId } : {}),
    ...(opts.chatMeta ? { chatMeta: opts.chatMeta } : {}),
    ...(opts.initialTurn !== undefined ? { initialTurn: opts.initialTurn } : {}),
    ...(opts.initialStep !== undefined ? { initialStep: opts.initialStep } : {}),
  });
}
