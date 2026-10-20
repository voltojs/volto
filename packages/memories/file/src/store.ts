/**
 * store.ts — append-only JSONL `MemoryStore` scoped per project.
 *
 * One file per scope under `rootDir`: `<projectId>.jsonl` for project
 * entries and `_global.jsonl` for global (or scope-less) entries. The
 * directory is created with mode 0700 and files with 0600 so memory
 * content (model-writable, potentially sensitive) never becomes
 * world-readable (spec §7).
 *
 * Loading is lazy: the first query/save touching a scope parses the file
 * into an in-memory `Map` and every later read is served from that index.
 * Writes append one JSONL row and update the index; deletes append a
 * tombstone row instead of rewriting (spec §4.3).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  MemoryEntry,
  MemoryQueryFilter,
  MemoryScope,
  MemoryStore,
} from "@volto/core";
import {
  scoreMemoryText,
  DEFAULT_MEMORY_MAX_ENTRIES,
} from "@volto/memory-common";

const ROW_VERSION = 1;
const DEFAULT_MAX_ENTRIES_PER_SCOPE = DEFAULT_MEMORY_MAX_ENTRIES;
/** Compact when the op count exceeds max(1000, live * 3) (spec §4.3). */
const COMPACT_FLOOR = 1000;
const COMPACT_MULTIPLE = 3;
/** Root is created with 0700 and memory files with 0600 (spec §7). */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

interface UpsertRow {
  version: number;
  op: "upsert";
  entry: MemoryEntry;
}

interface DeleteRow {
  version: number;
  op: "delete";
  id: string;
}

type Row = UpsertRow | DeleteRow;

export interface FileMemoryStoreOptions {
  /** Directory holding `<projectId>.jsonl` / `_global.jsonl`. */
  rootDir: string;
  /** Per-scope live-entry cap; oldest `createdAt` evicted first. */
  maxEntriesPerScope?: number;
  /** Injected clock used to backfill missing `createdAt` and generate ids. */
  now?: () => number;
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Resolve a memory scope to its file name inside `rootDir`. */
function fileNameFor(scope: MemoryScope): string {
  return scope.kind === "project"
    ? `${scope.projectId}.jsonl`
    : "_global.jsonl";
}

/**
 * A project id must be a single safe path segment: separators or `..`
 * would write outside `rootDir` (same guard as the spill store).
 */
function isValidProjectId(projectId: string): boolean {
  if (projectId.trim() === "") return false;
  if (projectId === "." || projectId === "..") return false;
  return !projectId.includes("/") && !projectId.includes("\\");
}

function requireValidProjectId(projectId: string): void {
  if (!isValidProjectId(projectId)) {
    throw new Error(
      `Invalid projectId: ${JSON.stringify(projectId)} — must be a non-empty path segment`,
    );
  }
}

/** Treat a missing scope as global (spec §4.1). */
function scopeOf(entry: MemoryEntry): MemoryScope {
  return entry.scope ?? { kind: "global" };
}

export function createFileMemoryStore(opts: FileMemoryStoreOptions): MemoryStore {
  const {
    rootDir,
    maxEntriesPerScope = DEFAULT_MAX_ENTRIES_PER_SCOPE,
    now = () => Date.now(),
  } = opts;

  // Lazy per-scope index: live entries plus the raw op count for compaction.
  const indexes = new Map<string, { entries: Map<string, MemoryEntry>; ops: number }>();
  // Serializes writes per scope so appends and compactions never interleave.
  const queues = new Map<string, Promise<void>>();
  let idCounter = 0;

  function filePath(scope: MemoryScope): string {
    return path.join(rootDir, fileNameFor(scope));
  }

  function generateId(): string {
    idCounter += 1;
    return `mem-${now()}-${idCounter}-${Math.random().toString(36).slice(2, 10)}`;
  }

  async function ensureDir(): Promise<void> {
    await fs.mkdir(rootDir, { recursive: true, mode: DIR_MODE });
  }

  /** Parse one line; returns undefined for torn/invalid lines (spec §6). */
  function parseRow(line: string): Row | undefined {
    const trimmed = line.trim();
    if (trimmed === "") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Torn/partial line — skip without failing the load (spec §6).
      return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const candidate = parsed as Partial<Row>;
    if (candidate.version !== ROW_VERSION) {
      console.warn(
        `Skipping memory line with unknown version: ${JSON.stringify(candidate.version)}`,
      );
      return undefined;
    }
    if (candidate.op === "upsert") {
      const entry = (candidate as Partial<UpsertRow>).entry;
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as MemoryEntry).id === "string" &&
        typeof (entry as MemoryEntry).text === "string"
      ) {
        return { version: ROW_VERSION, op: "upsert", entry: entry as MemoryEntry };
      }
      return undefined;
    }
    if (candidate.op === "delete") {
      const id = (candidate as Partial<DeleteRow>).id;
      if (typeof id === "string") {
        return { version: ROW_VERSION, op: "delete", id };
      }
    }
    return undefined;
  }

  async function readRows(target: string): Promise<Row[]> {
    let raw: string;
    try {
      raw = await fs.readFile(target, "utf-8");
    } catch (err: unknown) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const rows: Row[] = [];
    for (const line of raw.split("\n")) {
      const row = parseRow(line);
      if (row !== undefined) rows.push(row);
    }
    return rows;
  }

  async function loadScope(scope: MemoryScope): Promise<{
    entries: Map<string, MemoryEntry>;
    ops: number;
  }> {
    const key = fileNameFor(scope);
    const cached = indexes.get(key);
    if (cached !== undefined) return cached;

    const rows = await readRows(filePath(scope));
    const entries = new Map<string, MemoryEntry>();
    for (const row of rows) {
      if (row.op === "upsert") {
        entries.set(row.entry.id, row.entry);
      } else {
        entries.delete(row.id);
      }
    }
    const index = { entries, ops: rows.length };
    indexes.set(key, index);
    return index;
  }

  /**
   * Evict entries beyond the per-scope cap, oldest `createdAt` first.
   * Returns the evicted ids so the caller can persist tombstones — an
   * in-memory-only eviction would resurface on the next reload.
   */
  function enforceCap(index: { entries: Map<string, MemoryEntry> }): string[] {
    if (index.entries.size <= maxEntriesPerScope) return [];
    const sorted = [...index.entries.values()].sort(
      (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
    );
    const overflow = index.entries.size - maxEntriesPerScope;
    const victims: string[] = [];
    for (let i = 0; i < overflow; i += 1) {
      const victim = sorted[i];
      if (victim !== undefined) {
        index.entries.delete(victim.id);
        victims.push(victim.id);
      }
    }
    return victims;
  }

  /** Rewrite the scope file as one upsert row per live entry (atomic rename). */
  async function compact(scope: MemoryScope, index: {
    entries: Map<string, MemoryEntry>;
    ops: number;
  }): Promise<void> {
    const target = filePath(scope);
    const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
    const lines = [...index.entries.values()].map((entry) =>
      JSON.stringify({ version: ROW_VERSION, op: "upsert", entry }),
    );
    const text = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    await ensureDir();
    await fs.writeFile(tmp, text, { encoding: "utf-8", mode: FILE_MODE });
    await fs.rename(tmp, target);
    index.ops = index.entries.size;
  }

  /** Append one or more rows, then refresh the in-memory index and cap/compaction. */
  async function appendRows(scope: MemoryScope, rows: Row[]): Promise<void> {
    if (rows.length === 0) return;
    const key = fileNameFor(scope);
    const previous = queues.get(key) ?? Promise.resolve();
    const task = async (): Promise<void> => {
      const index = await loadScope(scope);
      // Track evictions across the batch: applying the upsert first may
      // push the scope over the cap, and its victims must reach disk as
      // delete rows in this same append, or a reload resurrects them.
      let victims: string[] = [];
      for (const row of rows) {
        if (row.op === "upsert") {
          index.entries.set(row.entry.id, row.entry);
        } else {
          index.entries.delete(row.id);
        }
        index.ops += 1;
        victims = victims.concat(enforceCap(index));
      }
      const persisted = rows.concat(
        victims.map((id): Row => ({ version: ROW_VERSION, op: "delete", id })),
      );
      const text = persisted.map((row) => `${JSON.stringify(row)}\n`).join("");
      await ensureDir();
      await fs.appendFile(filePath(scope), text, {
        encoding: "utf-8",
        mode: FILE_MODE,
      });
      index.ops += persisted.length - rows.length;
      if (index.ops > Math.max(COMPACT_FLOOR, index.entries.size * COMPACT_MULTIPLE)) {
        await compact(scope, index);
      }
    };
    const next = previous.then(task, task);
    queues.set(key, next.catch(() => undefined));
    await next;
  }

  /** Append a single row (see {@link appendRows}). */
  async function appendRow(scope: MemoryScope, row: Row): Promise<void> {
    await appendRows(scope, [row]);
  }

  /**
   * Every scope on disk: global plus every project file that has been
   * loaded or already exists under `rootDir` (the no-filter query path
   * must see every entry, spec §4.1).
   */
  async function allScopes(): Promise<MemoryScope[]> {
    const scopes: MemoryScope[] = [{ kind: "global" }];
    const seen = new Set<string>(["_global.jsonl"]);
    for (const key of indexes.keys()) {
      if (seen.has(key)) continue;
      seen.add(key);
      scopes.push({ kind: "project", projectId: key.replace(/\.jsonl$/, "") });
    }
    const dirents = await fs.readdir(rootDir).catch(() => [] as string[]);
    for (const name of dirents) {
      if (!name.endsWith(".jsonl") || seen.has(name)) continue;
      seen.add(name);
      scopes.push({ kind: "project", projectId: name.replace(/\.jsonl$/, "") });
    }
    return scopes;
  }

  /** Resolve which scopes a filter reads (spec §4.1). */
  async function scopesForFilter(filter?: MemoryQueryFilter): Promise<MemoryScope[]> {
    if (filter === undefined) {
      // No filter: every entry (advanced/test use only).
      return allScopes();
    }
    if (filter.projectId !== undefined) {
      requireValidProjectId(filter.projectId);
      const project: MemoryScope = {
        kind: "project",
        projectId: filter.projectId,
      };
      if (filter.includeGlobal === false) return [project];
      return [project, { kind: "global" }];
    }
    if (filter.includeGlobal === true) return [{ kind: "global" }];
    // includeGlobal: false without projectId (or an empty filter object):
    // never cross projects, return nothing.
    return [];
  }

  async function collectEntries(
    scopes: MemoryScope[],
  ): Promise<MemoryEntry[]> {
    const collected: MemoryEntry[] = [];
    const seenScopes = new Set<string>();
    for (const scope of scopes) {
      const key = fileNameFor(scope);
      if (seenScopes.has(key)) continue;
      seenScopes.add(key);
      const index = await loadScope(scope);
      collected.push(...index.entries.values());
    }
    return collected;
  }

  return {
    async save(input: MemoryEntry): Promise<string> {
      const scope = scopeOf(input);
      if (scope.kind === "project") requireValidProjectId(scope.projectId);
      const id = input.id === "" ? generateId() : input.id;
      const stored: MemoryEntry = {
        ...input,
        id,
        createdAt: input.createdAt ?? now(),
        scope,
      };
      await appendRow(scope, { version: ROW_VERSION, op: "upsert", entry: stored });
      return id;
    },

    async query(
      text: string,
      k: number = 10,
      filter?: MemoryQueryFilter,
    ): Promise<MemoryEntry[]> {
      const scopes = await scopesForFilter(filter);
      if (scopes.length === 0) return [];
      const candidates = await collectEntries(scopes);
      const tier = filter?.tier;
      const scored = candidates
        .filter((entry) => tier === undefined || entry.tier === tier)
        .map((entry) => ({ entry, score: scoreMemoryText(text, entry.text) }))
        .filter((r) => r.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            (b.entry.createdAt ?? 0) - (a.entry.createdAt ?? 0),
        );
      return scored.slice(0, k).map((r) => r.entry);
    },

    async delete(id: string): Promise<boolean> {
      // The id may live in any scope: check every known scope plus both
      // lazily-loaded candidates so a tombstone lands in the right file.
      const scopes: MemoryScope[] = [{ kind: "global" }];
      for (const key of indexes.keys()) {
        if (key !== "_global.jsonl") {
          scopes.push({ kind: "project", projectId: key.replace(/\.jsonl$/, "") });
        }
      }
      for (const scope of scopes) {
        const index = await loadScope(scope);
        if (index.entries.has(id)) {
          await appendRow(scope, { version: ROW_VERSION, op: "delete", id });
          return true;
        }
      }
      // Unknown id: also probe existing project files not yet loaded.
      const dirents = await fs.readdir(rootDir).catch(() => [] as string[]);
      for (const name of dirents) {
        if (!name.endsWith(".jsonl") || name === "_global.jsonl") continue;
        const scope: MemoryScope = {
          kind: "project",
          projectId: name.replace(/\.jsonl$/, ""),
        };
        const index = await loadScope(scope);
        if (index.entries.has(id)) {
          await appendRow(scope, { version: ROW_VERSION, op: "delete", id });
          return true;
        }
      }
      return false;
    },
  };
}
