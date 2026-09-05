/**
 * Pure helpers for workspace instruction files (AGENTS.md & friends): chain
 * path math, candidate ordering, dedupe, and byte-budgeted rendering. Zero
 * I/O — the host probes and reads files, then hands content snapshots in.
 * See docs/superpowers/specs/2026-09-05-agent-context-injection-design.md.
 */

import type { ContextLayer } from "./context-assembler.js";

/** One instruction file the host has already read and @import-expanded. */
export interface LoadedInstructionFile {
  /** Absolute host path — host-side bookkeeping, never rendered to the model. */
  absolutePath: string;
  /** Model-facing source label, e.g. "~/.volto/AGENTS.md" or "src/lib/AGENTS.md". */
  displayPath: string;
  /** Expanded file content (@import already resolved by the host). */
  content: string;
}

/** Base candidates probed in every chain directory, in precedence order. */
export const BASE_INSTRUCTION_FILES: readonly string[] = ["AGENTS.md", "CLAUDE.md"];

/** Local overlay candidates, probed after the base files of the same directory. */
export const LOCAL_INSTRUCTION_FILES: readonly string[] = ["AGENTS.local.md", "CLAUDE.local.md"];

/** Full per-directory probe order: base files first, local overlays after. */
export function candidateFileNames(): readonly string[] {
  return [...BASE_INSTRUCTION_FILES, ...LOCAL_INSTRUCTION_FILES];
}

/**
 * Directories from projectRoot down to cwd (broad → specific). Falls back to a
 * single-entry `[cwd]` chain when cwd lies outside projectRoot — the host's
 * root probe guarantees ancestor-or-self, this guard only keeps the function
 * total.
 */
export function ancestorChain(cwd: string, projectRoot: string): string[] {
  const strip = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const start = strip(cwd);
  const root = strip(projectRoot);
  if (start === root) return [start];
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!start.startsWith(prefix)) return [start];
  const chain = [root];
  let acc = root;
  for (const part of start.slice(prefix.length).split("/")) {
    if (part.length === 0) continue;
    acc = `${acc}/${part}`;
    chain.push(acc);
  }
  return chain;
}

/**
 * Drops files whose trimmed content equals an earlier candidate's — a
 * CLAUDE.md copying its AGENTS.md (in the same or a parent directory) must
 * not be injected twice. First in candidate order wins.
 */
export function dedupeInstructions(files: LoadedInstructionFile[]): LoadedInstructionFile[] {
  const seen = new Set<string>();
  const kept: LoadedInstructionFile[] = [];
  for (const file of files) {
    const key = file.content.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(file);
  }
  return kept;
}

export interface TruncationRecord {
  displayPath: string;
  originalBytes: number;
  includedBytes: number;
}

export interface RenderedInstructions {
  layers: ContextLayer[];
  /** displayPaths dropped whole by the budget (Task 4). */
  omitted: string[];
  /** displayPaths partially included by the budget (Task 4). */
  truncated: TruncationRecord[];
}

const USER_MEMORY_ID = "user-memory";

/** `~`-prefixed display paths are the user-global file; everything else is project-scoped. */
export function instructionLayerId(displayPath: string): string {
  return displayPath.startsWith("~/") ? USER_MEMORY_ID : `project-memory:${displayPath}`;
}

function sectionText(file: LoadedInstructionFile): string {
  return `Instructions from: ${file.displayPath}\n\n${file.content}`;
}

function layerFor(file: LoadedInstructionFile): ContextLayer {
  return { id: instructionLayerId(file.displayPath), text: sectionText(file) };
}

export function renderInstructionLayers(
  files: LoadedInstructionFile[],
  maxBytes: number,
): RenderedInstructions {
  if (files.length === 0) return { layers: [], omitted: [], truncated: [] };
  void maxBytes; // Task 4 enforces the budget; rendering is unbounded until then.
  return { layers: files.map(layerFor), omitted: [], truncated: [] };
}
