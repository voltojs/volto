/**
 * Skill discovery + on-demand body loading: the host-owned SkillRegistry port
 * implementation. Moved out of wiring.ts so the base-directory plumbing
 * (Task 6) and the future body cache (Task 7) have one home.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expandInstructions } from "@voltojs/core";
import type { LoadedSkill, SkillInvocationPolicy, SkillRegistry, SkillSummary } from "@voltojs/core";
import { getConfigDir } from "../config/paths.js";
import { loadInstructionFileTree } from "../instructions.js";
import { parseSkillFile, type ParsedSkillFile } from "./frontmatter.js";

/** Upper bound on cached metadata entries; oldest insertion is evicted first. */
const METADATA_CACHE_LIMIT = 256;

/**
 * The subset of ParsedSkillFile that is safe to cache. Deliberately excludes
 * `body`: skills are instructions and their files can change mid-session
 * (plan-016 §5.3), so a raw SKILL.md body must never sit retained in
 * module-level memory across calls. This is a structural exclusion, not a
 * discipline one — the type makes it impossible to accidentally cache (or
 * later read) a body off a cache entry, even under future refactors.
 */
type SkillMetadata = Pick<ParsedSkillFile, "name" | "description" | "invocation">;

/**
 * Parsed SKILL.md metadata (name/description/invocation only, never the
 * body — see SkillMetadata), keyed by path + mtime + size. The key changes
 * the moment the file does, so a stale entry is unreachable rather than
 * merely unlikely.
 */
const metadataCache = new Map<string, SkillMetadata>();

function cacheKey(skillPath: string, mtimeMs: number, size: number): string {
  return `${skillPath}:${mtimeMs}:${size}`;
}

function rememberMetadata(key: string, metadata: SkillMetadata): void {
  if (metadataCache.size >= METADATA_CACHE_LIMIT) {
    const oldest = metadataCache.keys().next();
    if (!oldest.done) metadataCache.delete(oldest.value);
  }
  metadataCache.set(key, metadata);
}

/**
 * Invocation-neutral scanned skill — the registry-local counterpart of a
 * SKILL.md directory entry. Carries metadata + invocation policy; bodies are
 * only read on demand through the SkillRegistry port (progressive disclosure).
 */
interface ScannedSkill {
  name: string;
  description: string;
  invocation: SkillInvocationPolicy;
  scope: "user" | "project";
  resources: string[];
  /** Absolute path of the SKILL.md entry file. */
  filePath: string;
  /** Absolute path of the skill's own directory (parent of SKILL.md). */
  baseDir: string;
  /** True when a higher-priority source defines the same name. */
  shadowed: boolean;
}

/**
 * All entries of one source directory. `shadowed` is decided by the caller
 * that merges sources, not here.
 */
interface ScannedSource {
  skills: ScannedSkill[];
  rootDirByResource: Map<string, string>;
}

interface ScannedSkills {
  /** Every entry from every source, in scan order, including shadowed ones. */
  entries: ScannedSkill[];
  /** The winning entry per name — what list() and load() must use. */
  byName: Map<string, ScannedSkill>;
  rootDirByResource: Map<string, string>;
}

/** Scans a skills directory (one subdirectory per skill, each containing SKILL.md) and loads them, tagging each skill's resource path with the rootDir @import expansion should use for it. */
async function loadSkillsFromDir(
  dir: string,
  rootDir: string,
  scope: "user" | "project",
): Promise<ScannedSource> {
  let entries: string[];
  try {
    // readdir order is filesystem-dependent; sort so the definition list is
    // stable across calls before the caller re-sorts by scope + name.
    entries = (await fs.readdir(dir)).sort();
  } catch {
    return { skills: [], rootDirByResource: new Map() };
  }
  const skills: ScannedSkill[] = [];
  const rootDirByResource = new Map<string, string>();
  for (const entry of entries) {
    const skillPath = path.join(dir, entry, "SKILL.md");
    try {
      // Metadata (name/description/invocation) is cached by mtime+size so a
      // 60+-skill catalog isn't reparsed every turn; the body is never
      // cached (see loadSkillResourceText) since skills are instructions and
      // their files can change mid-session.
      const stat = await fs.stat(skillPath);
      const key = cacheKey(skillPath, stat.mtimeMs, stat.size);
      let metadata: SkillMetadata | undefined = metadataCache.get(key);
      if (metadata === undefined) {
        const raw = await fs.readFile(skillPath, "utf-8");
        const parsed = parseSkillFile(raw);
        if (parsed) {
          // Project down to the metadata-only shape before it ever reaches
          // the cache — parsed.body is dropped here, not merely unused.
          metadata = { name: parsed.name, description: parsed.description, invocation: parsed.invocation };
          rememberMetadata(key, metadata);
        }
      }
      if (metadata) {
        skills.push({
          name: metadata.name,
          description: metadata.description,
          invocation: metadata.invocation,
          scope,
          resources: [skillPath],
          filePath: skillPath,
          baseDir: path.join(dir, entry),
          shadowed: false,
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
 * later entries override earlier ones — the project's `.volto/skills` beats
 * the user-level `<configDir>/skills`.
 *
 * These are the only two skill locations. Compatibility sources
 * (`.claude/skills`, `.agents/skills`) are deliberately not read: a skill
 * file the host never advertises cannot silently override the one it does.
 */
async function scanSkillSources(cwd: string): Promise<ScannedSkills> {
  const configDir = getConfigDir();
  const sources: Array<{
    root: string;
    subdir: string;
    rootDir: string;
    scope: "user" | "project";
  }> = [
    { root: configDir, subdir: "skills", rootDir: configDir, scope: "user" },
    { root: cwd, subdir: path.join(".volto", "skills"), rootDir: cwd, scope: "project" },
  ];
  const entries: ScannedSkill[] = [];
  const byName = new Map<string, ScannedSkill>();
  const rootDirByResource = new Map<string, string>();
  for (const source of sources) {
    const { skills } = await loadSkillsFromDir(
      path.join(source.root, source.subdir),
      source.rootDir,
      source.scope,
    );
    for (const skill of skills) {
      // The loser stays in `entries` with shadowed=true instead of being
      // discarded: "my edit had no effect" has to be self-diagnosable.
      const previous = byName.get(skill.name);
      if (previous !== undefined) previous.shadowed = true;
      byName.set(skill.name, skill);
      entries.push(skill);
      const resourcePath = skill.resources[0];
      if (resourcePath !== undefined) rootDirByResource.set(resourcePath, source.rootDir);
    }
  }
  return { entries, byName, rootDirByResource };
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
 * Host-owned SkillRegistry over the two-source skill directory scan.
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
      const { byName } = await scanSkillSources(cwd);
      return [...byName.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ name, description, invocation }) => ({ name, description, invocation }));
    },
    async load(name): Promise<LoadedSkill | undefined> {
      // Single scan of all skill sources, reused for both the name lookup
      // and the resource-root map loadSkillResourceText needs.
      const { byName, rootDirByResource } = await scanSkillSources(cwd);
      const hit = byName.get(name);
      if (hit === undefined || !hit.invocation.modelInvocable) return undefined;
      const body = await loadSkillResourceText(hit, rootDirByResource);
      return body === "" ? undefined : { body, baseDir: hit.baseDir };
    },
  };
}

/** One skill definition prepared for a host UI — includes shadowed losers. */
export interface SkillDefinitionEntry {
  /** `${scope}:${name}` */
  id: string;
  name: string;
  description: string;
  scope: "user" | "project";
  /** Absolute path of the SKILL.md entry file. */
  filePath: string;
  /** Absolute path of the skill's own directory. */
  baseDir: string;
  invocation: SkillInvocationPolicy;
  shadowed: boolean;
}

const SCOPE_ORDER: Record<"user" | "project", number> = { user: 0, project: 1 };

/**
 * Every on-disk skill definition, including same-named losers, for the
 * settings catalog. The model-facing `list()` keeps returning only winners.
 * Sorted user-level first, then by name, so the two UI groups render in a
 * stable order without client-side re-sorting.
 */
export async function listSkillDefinitions(cwd: string): Promise<SkillDefinitionEntry[]> {
  const { entries } = await scanSkillSources(cwd);
  return entries
    .slice()
    .sort(
      (a, b) =>
        SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || a.name.localeCompare(b.name),
    )
    .map((skill) => ({
      id: `${skill.scope}:${skill.name}`,
      name: skill.name,
      description: skill.description,
      scope: skill.scope,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      invocation: skill.invocation,
      shadowed: skill.shadowed,
    }));
}
