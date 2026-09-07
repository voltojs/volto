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
  dedupeInstructions,
  descendantChain,
  expandInstructions,
  renderInstructionLayers,
  type ContextLayer,
  type ContextLayerHints,
  type SkillInvocationPolicy,
  type SkillRegistry,
  type SkillSummary,
} from "@volto/core";
import type { ModelPort, PermissionConfig, Message, TranscriptStore, ChatSessionMeta } from "@volto/core";
import { getConfigDir } from "./config/paths.js";
import { collectInstructionFiles, loadInstructionFileTree, DEFAULT_MAX_INSTRUCTION_BYTES } from "./instructions.js";
import { parseSkillFile } from "./skills/frontmatter.js";

/**
 * Invocation-neutral scanned skill — the wiring-local counterpart of a
 * SKILL.md directory entry. Carries metadata + invocation policy; bodies are
 * only read on demand through the SkillRegistry port (progressive disclosure).
 */
interface ScannedSkill {
  name: string;
  description: string;
  invocation: SkillInvocationPolicy;
  resources: string[];
}

interface ScannedSkills {
  skills: ScannedSkill[];
  rootDirByResource: Map<string, string>;
}

/** Scans a skills directory (one subdirectory per skill, each containing SKILL.md) and loads them, tagging each skill's resource path with the rootDir @import expansion should use for it. */
async function loadSkillsFromDir(dir: string, rootDir: string): Promise<ScannedSkills> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { skills: [], rootDirByResource: new Map() };
  }
  const skills: ScannedSkill[] = [];
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
          invocation: parsed.invocation,
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
 * Scans every skill source fresh on each call — no caching: the registry's
 * load() must reread current disk state so mid-session skill edits are
 * picked up (skills are instructions; their files can change). Sources are
 * listed in ascending priority order and merged into a name-keyed map where
 * later entries override earlier ones — a project directory beats its
 * user-level counterpart, and within a level .volto beats .claude beats
 * .agents (the .claude/skills entries on real machines are frequently
 * symlinks into .agents/skills, so name-based dedupe is load-bearing).
 * User-level .agents/.claude hang off the real home directory (the
 * cross-tool convention), not the volto config dir.
 */
async function scanSkillSources(cwd: string): Promise<ScannedSkills> {
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
  const byName = new Map<string, ScannedSkill>();
  const rootDirByResource = new Map<string, string>();
  for (const source of sources) {
    const { skills } = await loadSkillsFromDir(path.join(source.root, source.subdir), source.rootDir);
    for (const skill of skills) {
      byName.set(skill.name, skill);
      const resourcePath = skill.resources[0];
      if (resourcePath !== undefined) rootDirByResource.set(resourcePath, source.rootDir);
    }
  }
  return { skills: [...byName.values()], rootDirByResource };
}

/** Loads a skill's resource files (each already-expanded via @import) and joins them. */
async function loadSkillResourceText(skill: ScannedSkill, rootDirByResource: Map<string, string>): Promise<string> {
  const parts: string[] = [];
  for (const resourcePath of skill.resources) {
    try {
      // Read the resource's own entry file directly (unguarded) so a
      // missing/unreadable resource throws here and is caught below.
      // loadInstructionFileTree() further down swallows *transitive*
      // @import failures on purpose (a missing imported file degrades to a
      // visible placeholder) — but the skill's own entry file failing to
      // exist (e.g. deleted between discovery and this read) should skip
      // loading entirely instead of injecting a
      // "[missing instruction file: ...]" placeholder into the conversation.
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
   * + discovered dirs, sacrificed in that order), enforced in core's
   * renderInstructionLayers. Defaults to DEFAULT_MAX_INSTRUCTION_BYTES
   * (64 KiB) — spec §5.5. Skill bodies never compete for this budget: they
   * are loaded on demand through the skillRegistry's skill tool.
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

  /**
   * Host-owned SkillRegistry port over the six-source skill directory scan.
   * list() → name/description/policy summaries only; load() → full body,
   * rereading disk every call (no caching) so mid-session skill edits are
   * picked up. Non-model-invocable skills are excluded from load() here;
   * the SDK's catalog layer additionally filters them out of list().
   * An empty loaded body (entry file vanished between scan and read, or a
   * legitimately empty body) is a miss: undefined keeps the tool's
   * "Unknown or non-invocable skill" error path instead of an empty hit.
   */
  const skillRegistry: SkillRegistry = {
    async list(): Promise<SkillSummary[]> {
      const { skills } = await scanSkillSources(cwd);
      return skills.map(({ name, description, invocation }) => ({ name, description, invocation }));
    },
    async load(name) {
      const { skills, rootDirByResource } = await scanSkillSources(cwd);
      const hit = skills.find((s) => s.name === name && s.invocation.modelInvocable);
      if (hit === undefined) return undefined;
      const body = await loadSkillResourceText(hit, rootDirByResource);
      return body === "" ? undefined : body;
    },
  };

  async function resolveContextLayers(_input: string, hints?: ContextLayerHints): Promise<ContextLayer[]> {
    const discoveredDirs = descendantChain(cwd, hints?.touchedPaths ?? []);
    const maxBytes = opts.maxInstructionBytes ?? DEFAULT_MAX_INSTRUCTION_BYTES;
    const loaded = await collectInstructionFiles(cwd, discoveredDirs);
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
    skillRegistry,
    ...(opts.permissionConfig ? { permissionConfig: opts.permissionConfig } : {}),
    ...(opts.initialMessages ? { initialMessages: opts.initialMessages } : {}),
    ...(opts.chatStore ? { chatStore: opts.chatStore } : {}),
    ...(opts.chatSessionId ? { chatSessionId: opts.chatSessionId } : {}),
    ...(opts.chatMeta ? { chatMeta: opts.chatMeta } : {}),
    ...(opts.initialTurn !== undefined ? { initialTurn: opts.initialTurn } : {}),
    ...(opts.initialStep !== undefined ? { initialStep: opts.initialStep } : {}),
  });
}
