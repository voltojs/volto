/**
 * Instruction file discovery for headless server: probes the user-level
 * cross-tool convention directories, the project ancestor chain, and
 * discovered directories, reading and @import-expanding each candidate.
 * Zero rendering here — the caller applies dedupe + core's pure
 * renderInstructionLayers() once over the collected set. See
 * docs/superpowers/specs/2026-09-05-agent-context-injection-design.md §5.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ancestorChain,
  candidateFileNames,
  expandInstructions,
  userInstructionDirs,
  type LoadedInstructionFile,
} from "@voltojs/core";
import { getConfigDir } from "./config/paths.js";

/**
 * Recursively reads an instruction file and every file it @imports (transitively)
 * into a path->content map, so the pure expandInstructions() function can resolve
 * them without doing any I/O itself. A missing or unreadable imported file is
 * simply left out of the map — expandInstructions() already renders a
 * "[missing instruction file: ...]" placeholder for that case (that fallback is
 * a deliberate, tested part of its contract; this loader does not change it).
 */
export async function loadInstructionFileTree(entryPath: string): Promise<Map<string, string>> {
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

export const DEFAULT_MAX_INSTRUCTION_BYTES = 64 * 1024;

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
 * Renders an absolute path as a `~`-prefixed display path when it sits under
 * the home directory. Model-facing only — the absolute path stays in
 * absolutePath for host bookkeeping.
 */
function displayUnderHome(absolutePath: string, home: string): string {
  const prefix = home.endsWith("/") ? home : `${home}/`;
  return absolutePath.startsWith(prefix)
    ? `~/${absolutePath.slice(prefix.length)}`
    : absolutePath;
}

/**
 * Collects this turn's instruction files, UNRENDERED: the user level (the
 * cross-tool convention directories, broad → specific), the project chain
 * (projectRoot → cwd, broad → specific), then discovered directories
 * strictly below cwd. No rendering here — the caller applies dedupe + core's
 * pure renderInstructionLayers() once over the collected set. See
 * docs/superpowers/specs/2026-09-05-agent-context-injection-design.md §5.
 */
export async function collectInstructionFiles(
  cwd: string,
  discoveredDirs: string[],
): Promise<LoadedInstructionFile[]> {
  const configDir = getConfigDir();
  const home = os.homedir();
  const loaded: LoadedInstructionFile[] = [];

  // User level: the same candidate rules as the project chain, across the
  // cross-tool convention directories. Skill discovery already resolves
  // .agents/.claude against the real home dir; instructions must match, or a
  // user's existing ~/.claude/CLAUDE.md stays invisible to the agent.
  // Symlinked duplicates (.claude/CLAUDE.md -> .agents/AGENTS.md is common)
  // are removed later by the caller's dedupeInstructions().
  for (const dir of userInstructionDirs(home, configDir)) {
    for (const name of candidateFileNames()) {
      const filePath = path.join(dir, name);
      const text = await loadExpanded(filePath, dir);
      if (text === undefined) continue;
      loaded.push({
        absolutePath: filePath,
        displayPath: displayUnderHome(filePath, home),
        content: text,
        origin: "user",
      });
    }
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
        origin: "project",
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
        origin: "discovered",
      });
    }
  }

  return loaded;
}
