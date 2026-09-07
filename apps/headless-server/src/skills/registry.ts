/**
 * Skill discovery + on-demand body loading: the host-owned SkillRegistry port
 * implementation. Moved out of wiring.ts so the base-directory plumbing
 * (Task 6) and the future body cache (Task 7) have one home.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expandInstructions } from "@volto/core";
import type { LoadedSkill, SkillInvocationPolicy, SkillRegistry, SkillSummary } from "@volto/core";
import { getConfigDir } from "../config/paths.js";
import { loadInstructionFileTree } from "../instructions.js";
import { parseSkillFile } from "./frontmatter.js";

/**
 * Invocation-neutral scanned skill — the registry-local counterpart of a
 * SKILL.md directory entry. Carries metadata + invocation policy; bodies are
 * only read on demand through the SkillRegistry port (progressive disclosure).
 */
interface ScannedSkill {
  name: string;
  description: string;
  invocation: SkillInvocationPolicy;
  resources: string[];
  /** Absolute path of the skill's own directory (parent of SKILL.md). */
  baseDir: string;
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
          baseDir: path.join(dir, entry),
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
 * Host-owned SkillRegistry over the six-source skill directory scan.
 * list() → name/description/policy summaries only; load() → body plus the
 * skill's own directory, rereading disk every call (no body caching) so
 * mid-session skill edits are picked up. Non-model-invocable skills are
 * excluded from load() here; the SDK's catalog layer additionally filters
 * them out of list(). An empty loaded body (entry file vanished between scan
 * and read, or a legitimately empty body) is a miss: undefined keeps the
 * tool's "Unknown or non-invocable skill" error path instead of an empty hit.
 */
export function createSkillRegistry(cwd: string): SkillRegistry {
  return {
    async list(): Promise<SkillSummary[]> {
      const { skills } = await scanSkillSources(cwd);
      return skills.map(({ name, description, invocation }) => ({ name, description, invocation }));
    },
    async load(name): Promise<LoadedSkill | undefined> {
      // One scan for both the lookup and the resource roots — the previous
      // shape scanned twice per call.
      const { skills, rootDirByResource } = await scanSkillSources(cwd);
      const hit = skills.find((s) => s.name === name && s.invocation.modelInvocable);
      if (hit === undefined) return undefined;
      const body = await loadSkillResourceText(hit, rootDirByResource);
      return body === "" ? undefined : { body, baseDir: hit.baseDir };
    },
  };
}
