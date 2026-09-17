/**
 * Multi-level agent definition scan and merge.
 *
 * Scans every source fresh on each call — no caching. Definitions are files
 * a user edits mid-session, so a cached registry would serve stale agents.
 * Sources are listed in ascending priority; a later entry with the same name
 * wins and marks the earlier one shadowed rather than discarding it, because
 * "my edit had no effect" is otherwise impossible to self-diagnose.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSpec } from "../agent-spec.js";
import { parseAgentFile } from "./frontmatter.js";

export interface AgentEntry {
  /** `${scope}:${name}` — not unique across same-scope collisions. */
  id: string;
  scope: "project" | "user" | "plugin";
  spec: AgentSpec;
  filePath?: string;
  /** True when a higher-priority source defines the same name. */
  shadowed: boolean;
  unknownKeys?: Record<string, unknown>;
}

export interface AgentScanResult {
  entries: AgentEntry[];
  /** One per skipped file: path plus reason. */
  warnings: string[];
}

export interface ScanAgentSourcesOptions {
  cwd: string;
  configDir: string;
  homeDir: string;
  pluginSpecs?: AgentSpec[];
}

/**
 * File sources in ascending priority (later wins). Order mirrors the skill
 * registry: user-level homes first, then project; within a level `.volto`
 * beats `.claude` beats `.agents`. Exported because the write layer shares
 * this layout for same-scope duplicate checks.
 */
export function fileSources(opts: {
  cwd: string;
  configDir: string;
  homeDir: string;
}): Array<{ dir: string; scope: "user" | "project" }> {
  const { cwd, configDir, homeDir } = opts;
  return [
    { dir: path.join(homeDir, ".agents", "agents"), scope: "user" },
    { dir: path.join(homeDir, ".claude", "agents"), scope: "user" },
    { dir: path.join(configDir, "agents"), scope: "user" },
    { dir: path.join(cwd, ".agents", "agents"), scope: "project" },
    { dir: path.join(cwd, ".claude", "agents"), scope: "project" },
    { dir: path.join(cwd, ".volto", "agents"), scope: "project" },
  ];
}

/**
 * Reads every `.md` file in a source directory. A missing directory is not
 * an error — most machines have none of these paths. Files that fail to
 * parse become warnings so one bad definition never takes the scan down.
 */
async function loadSourceDir(
  dir: string,
  scope: "user" | "project",
  warnings: string[],
): Promise<AgentEntry[]> {
  let names: string[];
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    names = dirents
      .filter((d) => d.isFile() && d.name.endsWith(".md"))
      .map((d) => d.name)
      .sort();
  } catch {
    // Missing (or unreadable) directory — skip silently.
    return [];
  }

  const entries: AgentEntry[] = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (err) {
      warnings.push(
        `${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const parsed = parseAgentFile(raw, filePath);
    if ("error" in parsed) {
      warnings.push(parsed.error);
      continue;
    }
    entries.push({
      id: `${scope}:${parsed.spec.name}`,
      scope,
      spec: parsed.spec,
      filePath,
      shadowed: false,
      ...(Object.keys(parsed.unknownKeys).length > 0
        ? { unknownKeys: parsed.unknownKeys }
        : {}),
    });
  }
  return entries;
}

/**
 * Scan plugin specs plus every on-disk source directory and merge them by
 * agent name. Later (higher-priority) sources win; losers stay in `entries`
 * with `shadowed: true` so a host UI can show why an edit had no effect.
 */
export async function scanAgentSources(
  opts: ScanAgentSourcesOptions,
): Promise<AgentScanResult> {
  const entries: AgentEntry[] = [];
  const warnings: string[] = [];
  const winners = new Map<string, AgentEntry>();

  const add = (entry: AgentEntry): void => {
    const prev = winners.get(entry.spec.name);
    if (prev) prev.shadowed = true;
    winners.set(entry.spec.name, entry);
    entries.push(entry);
  };

  // Plugin specs sit at the lowest priority — every file source outranks them.
  for (const spec of opts.pluginSpecs ?? []) {
    add({
      id: `plugin:${spec.name}`,
      scope: "plugin",
      spec,
      shadowed: false,
    });
  }

  for (const source of fileSources(opts)) {
    const loaded = await loadSourceDir(source.dir, source.scope, warnings);
    for (const entry of loaded) add(entry);
  }

  return { entries, warnings };
}
