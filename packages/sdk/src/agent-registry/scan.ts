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
  pluginSpecs?: AgentSpec[];
  /**
   * When provided, every declared `tools:` name that matches none of them is
   * reported as a warning. Definitions imported from other agent products are
   * written against a different tool namespace (`run_bash_command`,
   * `search_files`); the intersection rule drops them at dispatch time, and
   * without this check the loss is only visible by transcript archaeology.
   * Hosts pass the full set of tool names they can grant; omitted = no check
   * (a host whose tool set is dynamic should prefer the runtime
   * `subagent_tools_dropped` event instead of a false alarm here).
   */
  knownToolNames?: ReadonlySet<string>;
}

/**
 * File sources in ascending priority (later wins): user-level
 * `<configDir>/agents` first, then the project's `.volto/agents`.
 *
 * These are the only two definition locations. Compatibility sources
 * (`.claude/agents`, `.agents/agents`) are deliberately not read: an agent
 * definition has one home, so a file the settings UI never shows cannot
 * silently override the one it does.
 *
 * Exported because the write layer shares this layout for same-scope
 * duplicate checks.
 */
export function fileSources(opts: {
  cwd: string;
  configDir: string;
}): Array<{ dir: string; scope: "user" | "project" }> {
  const { cwd, configDir } = opts;
  return [
    { dir: path.join(configDir, "agents"), scope: "user" },
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
  knownToolNames?: ReadonlySet<string>,
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
    if (knownToolNames && parsed.spec.tools) {
      for (const toolName of parsed.spec.tools) {
        if (!knownToolNames.has(toolName)) {
          warnings.push(
            `${filePath}: tools entry "${toolName}" is not a known tool name; ` +
              `it will be dropped from any dispatch of "${parsed.spec.name}".`,
          );
        }
      }
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
    const loaded = await loadSourceDir(
      source.dir,
      source.scope,
      warnings,
      opts.knownToolNames,
    );
    for (const entry of loaded) add(entry);
  }

  return { entries, warnings };
}
