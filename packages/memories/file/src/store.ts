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
} from "@voltojs/core";
import {
  scoreMemoryText,
  DEFAULT_MEMORY_MAX_ENTRIES,
} from "@voltojs/memory-common";

const ROW_VERSION = 1;
/** A missing tier normalizes to this default (core MemoryEntry contract). */
const DEFAULT_TIER = "semantic" as const;
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
  // `_global` is reserved: it names the shared _global.jsonl file, so a
  // project with that id would read and write the global scope — leaking
  // its memories into every project's view and vice versa.
  if (projectId === "_global") return false;
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
  type ScopeIndex = { entries: Map<string, MemoryEntry>; ops: number };
  const indexes = new Map<string, ScopeIndex>();
  // In-flight cold loads, keyed like `indexes`. Each entry is removed as soon
  // as the read settles (success or failure), so a failed load is retried on
  // the next access instead of being cached as an error.
  const loads = new Map<string, Promise<ScopeIndex>>();
  // Serializes writes per scope so appends and compactions never interleave.
  const queues = new Map<string, Promise<void>>();
  let idCounter = 0;

  function filePath(scope: MemoryScope): string {
    return path.join(rootDir, fileNameFor(scope));
  }

  function generateId(): string {
    // Deterministic within the single-process assumption (spec §9.6): the
    // monotonic counter keeps same-millisecond ids apart, and the pid keeps
    // two processes from colliding. No randomness, so tests can pin ids.
    idCounter += 1;
    return `mem-${process.pid}-${now()}-${idCounter}`;
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

  async function loadScope(scope: MemoryScope): Promise<ScopeIndex> {
    const key = fileNameFor(scope);
    const cached = indexes.get(key);
    if (cached !== undefined) return cached;

    // Concurrent cold-start readers share one in-flight read. Without this, a
    // query and a save hitting a fresh scope each build their own index from
    // the same file; whichever `indexes.set` lands last overwrites the other
    // one's applied writes, making them invisible in memory and — once a later
    // compact rewrites the file from the stale map — lost on disk.
    const inflight = loads.get(key);
    if (inflight !== undefined) return inflight;

    const loading = readRows(filePath(scope)).then(
      (rows): ScopeIndex => {
        const entries = new Map<string, MemoryEntry>();
        for (const row of rows) {
          if (row.op === "upsert") {
            entries.set(row.entry.id, row.entry);
          } else {
            entries.delete(row.id);
          }
        }
        const index: ScopeIndex = { entries, ops: rows.length };
        indexes.set(key, index);
        loads.delete(key);
        return index;
      },
      (err: unknown) => {
        loads.delete(key);
        throw err;
      },
    );
    loads.set(key, loading);
    return loading;
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
    // Compaction runs inside the per-scope write queue, so one pid-stamped
    // tmp name is unique without randomness; the catch removes it when the
    // rename never happened so a failed compaction leaves no orphan behind.
    const tmp = `${target}.tmp.${process.pid}`;
    const lines = [...index.entries.values()].map((entry) =>
      JSON.stringify({ version: ROW_VERSION, op: "upsert", entry }),
    );
    const text = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    await ensureDir();
    try {
      await fs.writeFile(tmp, text, { encoding: "utf-8", mode: FILE_MODE });
      await fs.rename(tmp, target);
    } catch (err: unknown) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    index.ops = index.entries.size;
  }

  /** Append one or more rows, then refresh the in-memory index and cap/compaction. */
  async function appendRows(scope: MemoryScope, rows: Row[]): Promise<void> {
    if (rows.length === 0) return;
    const key = fileNameFor(scope);
    const previous = queues.get(key) ?? Promise.resolve();
    const task = async (): Promise<void> => {
      const index = await loadScope(scope);
      // Apply the batch to a copy and publish it only after the append has
      // reached disk (spec §4.3 write order: append, then update the index).
      // Mutating the live index first would leave phantom entries — or
      // resurrected eviction victims — in memory whenever the append fails,
      // and a later recall would return rows that were never persisted.
      const nextEntries = new Map(index.entries);
      let nextOps = index.ops;
      // Track evictions across the batch: applying the upsert first may
      // push the scope over the cap, and its victims must reach disk as
      // delete rows in this same append, or a reload resurrects them.
      let victims: string[] = [];
      for (const row of rows) {
        if (row.op === "upsert") {
          nextEntries.set(row.entry.id, row.entry);
        } else {
          nextEntries.delete(row.id);
        }
        nextOps += 1;
        victims = victims.concat(enforceCap({ entries: nextEntries }));
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
      // The write reached disk: publish the new view.
      index.entries = nextEntries;
      index.ops = nextOps + persisted.length - rows.length;
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
    const dirents = await fs.readdir(rootDir).catch((err: unknown) => {
      // A missing root is the normal first-use case; anything else (EACCES
      // etc.) would silently truncate the scope list, so surface it.
      if (!isEnoent(err)) {
        console.warn(
          `memory-file: cannot list ${rootDir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return [] as string[];
    });
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
    // A tier-only filter has no project context: global only, never every
    // project. includeGlobal:false (or an empty filter object) returns nothing.
    if (filter.includeGlobal === undefined && filter.tier !== undefined) {
      return [{ kind: "global" }];
    }
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
        // Normalize the missing tier to the default so both stores answer a
        // tier-filtered query identically for tier-less entries (core
        // MemoryEntry contract).
        tier: input.tier ?? DEFAULT_TIER,
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
        // Entries persisted before tier normalization lack the field; treat
        // them as the default tier (same rule as save).
        .filter((entry) => tier === undefined || (entry.tier ?? DEFAULT_TIER) === tier)
        .map((entry) => ({ entry, score: scoreMemoryText(text, entry.text) }))
        .filter((r) => r.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            (b.entry.createdAt ?? 0) - (a.entry.createdAt ?? 0),
        );
      // Return copies: handing out the index's own objects would let a
      // caller mutate the in-memory view (the inmemory store copies too).
      return scored.slice(0, k).map((r) => ({ ...r.entry }));
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
      const dirents = await fs.readdir(rootDir).catch((err: unknown) => {
      // A missing root is the normal first-use case; anything else (EACCES
      // etc.) would silently truncate the scope list, so surface it.
      if (!isEnoent(err)) {
        console.warn(
          `memory-file: cannot list ${rootDir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return [] as string[];
    });
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
