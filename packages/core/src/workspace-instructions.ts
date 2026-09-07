/**
 * Pure helpers for workspace instruction files (AGENTS.md & friends): chain
 * path math, candidate ordering, dedupe, and byte-budgeted rendering. Also
 * hosts the history-derived context hints (fs-tool path touches and their
 * descendant directory chains). Zero I/O — the host probes and reads files,
 * then hands content snapshots in.
 * See docs/superpowers/specs/2026-09-05-agent-context-injection-design.md.
 */

import type { ContextLayer } from "./context-assembler.js";
import type { Message } from "./state.js";

export type { Message };

/**
 * Where an instruction file came from. Drives two things: the layer id
 * prefix, and the byte-budget sacrifice order (discovered files are given up
 * before project files, project files before user-level ones).
 */
export type InstructionOrigin = "user" | "project" | "discovered";

/** One instruction file the host has already read and @import-expanded. */
export interface LoadedInstructionFile {
  /** Absolute host path — host-side bookkeeping, never rendered to the model. */
  absolutePath: string;
  /** Model-facing source label, e.g. "~/.claude/CLAUDE.md" or "src/lib/AGENTS.md". */
  displayPath: string;
  /** Expanded file content (@import already resolved by the host). */
  content: string;
  /** Provenance — see InstructionOrigin. */
  origin: InstructionOrigin;
  /** Overrides the displayPath-derived layer id (skill layers use `skill:<name>`). */
  id?: string;
}

/**
 * User-level instruction directories in ascending precedence order (later
 * entries win on dedupe). `.agents` and `.claude` hang off the real home
 * directory — that is the cross-tool convention, and skill discovery already
 * follows it. Pure path math; the host probes these for candidateFileNames().
 */
export function userInstructionDirs(home: string, configDir: string): string[] {
  const strip = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const h = strip(home);
  return [`${h}/.agents`, `${h}/.claude`, strip(configDir)];
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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

/** Cuts a UTF-8 byte prefix without splitting a code point, then decodes losslessly. */
function cutUtf8(bytes: Uint8Array, maxBytes: number): Uint8Array {
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.slice(0, end);
}

/** UTF-8-safe truncation for display/tests: never splits a multi-byte code point. */
export function truncateUtf8(value: string, maxBytes: number): string {
  return decoder.decode(cutUtf8(encoder.encode(value), maxBytes));
}

/**
 * Layer id per file. Every user-level file gets its own id: a fixed shared id
 * would emit duplicate ids into request_header.systemLayers once more than one
 * user-level file exists, breaking the usage meter's per-layer breakdown and
 * the trajectory drawer's layer grouping.
 */
export function instructionLayerId(displayPath: string, origin: InstructionOrigin): string {
  return origin === "user" ? `user-memory:${displayPath}` : `project-memory:${displayPath}`;
}

function sectionText(file: LoadedInstructionFile): string {
  return `Instructions from: ${file.displayPath}\n\n${file.content}`;
}

function layerFor(file: LoadedInstructionFile): ContextLayer {
  return { id: file.id ?? instructionLayerId(file.displayPath, file.origin), text: sectionText(file) };
}

function noticeLine(maxBytes: number, omitted: string[], truncated: TruncationRecord[]): string {
  const parts: string[] = [];
  if (omitted.length > 0) parts.push(`omitted ${omitted.join(", ")}`);
  for (const t of truncated) {
    parts.push(`truncated ${t.displayPath} from ${t.originalBytes} to ${t.includedBytes} bytes`);
  }
  return `Workspace instruction budget ${maxBytes} bytes: ${parts.join("; ")}`;
}

const ORIGIN_SACRIFICE_RANK: Record<InstructionOrigin, number> = {
  discovered: 0,
  project: 1,
  user: 2,
};

function pathDepth(absolutePath: string): number {
  return absolutePath.split("/").filter((s) => s.length > 0).length;
}

/**
 * Indices into `files`, ordered by what to give up first: discovered files
 * before project files before user-level ones, and within a group the deepest
 * path first. Broader instructions are the explicitly-declared, stable ones;
 * deeper ones are incidental (a directory the model happened to touch) — and
 * keeping the broad ones stable also keeps the cached prefix intact.
 * Ties keep input order, so the queue is fully deterministic.
 */
function sacrificeOrder(files: LoadedInstructionFile[]): number[] {
  return files
    .map((file, index) => ({ file, index }))
    .sort((a, b) => {
      const rank = ORIGIN_SACRIFICE_RANK[a.file.origin] - ORIGIN_SACRIFICE_RANK[b.file.origin];
      if (rank !== 0) return rank;
      const depth = pathDepth(b.file.absolutePath) - pathDepth(a.file.absolutePath);
      if (depth !== 0) return depth;
      return a.index - b.index;
    })
    .map((entry) => entry.index);
}

export function renderInstructionLayers(
  files: LoadedInstructionFile[],
  maxBytes: number,
): RenderedInstructions {
  if (files.length === 0) return { layers: [], omitted: [], truncated: [] };
  if (maxBytes <= 0 || !Number.isFinite(maxBytes)) {
    return { layers: [], omitted: files.map((f) => f.displayPath), truncated: [] };
  }

  const rendered = files.map(layerFor);
  const sum = (ls: ContextLayer[]): number => ls.reduce((acc, l) => acc + utf8Bytes(l.text), 0);
  if (sum(rendered) <= maxBytes) return { layers: rendered, omitted: [], truncated: [] };

  // Drop whole files in sacrifice order (see sacrificeOrder). Rendering order
  // is independent of it: survivors are always emitted in the original
  // broad-to-specific input order, which is what the cached prefix depends on.
  const queue = sacrificeOrder(files);
  const kept = new Set(files.map((_, i) => i));
  const omitted: string[] = [];
  let cursor = 0;
  const keptLayers = (): ContextLayer[] => rendered.filter((_, i) => kept.has(i));
  while (kept.size > 1 && sum(keptLayers()) > maxBytes) {
    const victim = queue[cursor]!;
    cursor += 1;
    if (!kept.has(victim)) continue;
    kept.delete(victim);
    omitted.push(files[victim]!.displayPath);
  }

  const layers = keptLayers();
  if (sum(layers) <= maxBytes) {
    // Spec §5.5.3 — the budget notice is model-visible: when files were
    // omitted whole, append one notice line to the last surviving layer. The
    // notice counts against the budget — append the full line when the
    // combined text fits, otherwise clip the notice itself to the remaining
    // space; append nothing only when not even one byte of it fits
    // (degenerate — `omitted` still carries the machine-readable list).
    if (omitted.length > 0) {
      const available = maxBytes - sum(layers) - 1; // -1 for the "\n" separator
      if (available > 0) {
        const notice = noticeLine(maxBytes, omitted, []);
        const lastLayer = layers[layers.length - 1]!;
        const appended = `${lastLayer.text}\n${notice}`;
        lastLayer.text =
          utf8Bytes(appended) <= maxBytes
            ? appended
            : `${lastLayer.text}\n${truncateUtf8(notice, available)}`;
      }
    }
    return { layers, omitted, truncated: [] };
  }

  // Only one file survives and it alone exceeds the budget: binary-search the
  // longest UTF-8-safe content prefix whose full layer text (heading +
  // content + notice) fits — the notice counts against the budget.
  const survivorIndex = [...kept][0]!;
  const last = files[survivorIndex]!;
  const heading = `Instructions from: ${last.displayPath}\n\n`;
  const originalBytes = utf8Bytes(last.content);
  const bytes = encoder.encode(last.content);
  const textFor = (contentBytes: Uint8Array, includedBytes: number): string => {
    const notice = noticeLine(maxBytes, omitted, [
      { displayPath: last.displayPath, originalBytes, includedBytes },
    ]);
    return `${heading}${decoder.decode(contentBytes)}\n${notice}`;
  };

  let low = 0;
  let high = bytes.length;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const sliced = cutUtf8(bytes, mid);
    if (utf8Bytes(textFor(sliced, sliced.length)) <= maxBytes) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const finalSlice = cutUtf8(bytes, best);
  const truncated: TruncationRecord[] = [
    { displayPath: last.displayPath, originalBytes, includedBytes: finalSlice.length },
  ];
  // Degenerate cap where even the notice cannot fit: the truncated notice
  // itself is the layer (spec §5.5 — the notice is bounded last of all).
  let text = textFor(finalSlice, finalSlice.length);
  if (utf8Bytes(text) > maxBytes) text = truncateUtf8(noticeLine(maxBytes, omitted, truncated), maxBytes);
  return {
    layers: [{ id: last.id ?? instructionLayerId(last.displayPath, last.origin), text }],
    omitted,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// History-derived context hints — fs-tool path touches and their descendant
// directory chains (pure; the SDK scans history and hands the host hints).
// ---------------------------------------------------------------------------

/** Structured fs tools whose `path` input counts as a directory touch. */
export const FS_PATH_TOOLS: readonly string[] = ["read_file", "write_file", "edit_file", "ls"];

/** Per-turn hint payload the SDK derives from history and hands the host. */
export interface ContextLayerHints {
  /** Raw tool paths (relative to the agent cwd, exactly as the tool received them). */
  touchedPaths: string[];
}

/**
 * Scans assistant tool_use blocks for structured fs tool paths. Every path
 * ever touched stays in the hint set for the rest of the conversation —
 * discovered directories are a stable superset, recomputed each turn.
 */
export function extractTouchedToolPaths(messages: Message[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      if (!FS_PATH_TOOLS.includes(block.name)) continue;
      const path = block.input["path"];
      if (typeof path !== "string" || path.length === 0) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Lexically resolves "." and ".." segments (rooted — clamped at "/") without
 * node:path, keeping the pure core free of Node builtins.
 */
function normalizeAbsolute(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/**
 * Directories strictly below cwd leading down to each touched path's parent,
 * shallow-first (they sacrifice first under the byte budget). Paths above or
 * directly in cwd contribute nothing — the project chain already covers them.
 */
export function descendantChain(cwd: string, touchedPaths: string[]): string[] {
  const root = cwd.length > 1 ? cwd.replace(/\/+$/, "") : cwd;
  const prefix = root === "/" ? "/" : `${root}/`;
  const seen = new Set<string>();
  const found: string[] = [];
  for (const raw of touchedPaths) {
    if (raw.length === 0) continue;
    const absolute = normalizeAbsolute(raw.startsWith("/") ? raw : `${root}/${raw}`);
    const cut = absolute.lastIndexOf("/");
    const startDir = cut <= 0 ? "/" : absolute.slice(0, cut);
    let current = startDir;
    while (current.startsWith(prefix) && current !== root) {
      if (!seen.has(current)) {
        seen.add(current);
        found.push(current);
      }
      const parentCut = current.lastIndexOf("/");
      current = parentCut <= 0 ? "/" : current.slice(0, parentCut);
    }
  }
  return found.sort((a, b) => a.split("/").length - b.split("/").length);
}
