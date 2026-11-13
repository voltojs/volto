/**
 * In-memory layered MemoryStore implementation.
 *
 * Implements the `MemoryStore` port with lexical scoring (spec §4.1/§4.3):
 * - query filters by scope / tier first, then ranks with `scoreMemoryText`
 *   from `@voltojs/memory-common`, returning only entries with score > 0.
 * - A missing entry `scope` is treated as global (spec §4.1).
 * - `id: ""` is replaced by a store-generated id; missing `createdAt` is
 *   backfilled from the injected clock.
 *
 * Tier bookkeeping uses the public `MemoryEntry.tier` field plus a local
 * fallback tier for entries saved before tiering was explicit. The local
 * `MemoryTier` union also carries "working", a local-only concept that the
 * core port does not define (spec §4.1 core tier is episodic / semantic).
 */

import type {
  MemoryStore,
  MemoryEntry,
  MemoryQueryFilter,
  MemoryScope,
  Embedder,
} from "@voltojs/core";
import { scoreMemoryText } from "@voltojs/memory-common";

export type MemoryTier = "working" | "episodic" | "semantic";

export interface InMemoryMemoryStoreOptions {
  /** Embedder for semantic layer similarity search (optional override) */
  embedder?: Embedder;
  /** Default tier for save operations (default: "semantic") */
  defaultTier?: MemoryTier;
  /** Injected clock used to backfill missing `createdAt` (default Date.now). */
  now?: () => number;
}

type StoredEntry = MemoryEntry & {
  /** Local-only fallback tier (pre-tiering entries; "working" stays local). */
  _tier?: MemoryTier;
  _embedding?: number[];
};

/**
 * In-process store with no entry cap: it holds whatever the caller saved in
 * this process only, and no production wiring uses it as a durable memory
 * (the file store owns persistence and enforces DEFAULT_MEMORY_MAX_ENTRIES).
 */
export function createInMemoryMemoryStore(
  opts: InMemoryMemoryStoreOptions = {},
): MemoryStore & {
  /** Query by tier (optional filter) */
  queryByTier(text: string, k: number, tier?: MemoryTier): Promise<MemoryEntry[]>;
  /** Save with explicit tier */
  saveWithTier(entry: Omit<MemoryEntry, "id"> & { id?: string }, tier: MemoryTier): Promise<string>;
} {
  const {
    embedder,
    defaultTier = "semantic",
    now = () => Date.now(),
  } = opts;
  const entries = new Map<string, StoredEntry>();
  let idCounter = 0;

  function generateId(): string {
    idCounter++;
    return `mem-${idCounter}-${now()}`;
  }

  /** Backfill missing createdAt from the injected clock (spec §4.1). */
  function withCreatedAt(entry: MemoryEntry): number {
    return entry.createdAt ?? now();
  }

  async function storeEntry(
    input: Omit<MemoryEntry, "id"> & { id?: string },
    tier: MemoryTier,
  ): Promise<string> {
    const id = input.id && input.id !== "" ? input.id : generateId();
    const stored: StoredEntry = {
      ...input,
      id,
      createdAt: withCreatedAt({ ...input, id }),
      tier: input.tier ?? (tier === "working" ? undefined : tier),
      _tier: tier,
    };
    entries.set(id, stored);

    // Compute embedding for semantic layer if embedder is available
    if (tier === "semantic" && embedder && input.text) {
      try {
        const embeddings = await embedder.embed([input.text]);
        if (embeddings[0]) {
          stored._embedding = embeddings[0];
        }
      } catch {
        // Embedding failure is non-fatal — entry is still saved
      }
    }

    return id;
  }

  /** Scope of an entry, treating a missing scope as global (spec §4.1). */
  function scopeOf(entry: MemoryEntry): MemoryScope {
    return entry.scope ?? { kind: "global" };
  }

  /** Whether an entry passes the §4.1 scope branches of `filter`. */
  function matchesScope(entry: MemoryEntry, filter?: MemoryQueryFilter): boolean {
    if (filter === undefined) return true;
    const scope = scopeOf(entry);
    if (filter.projectId !== undefined) {
      if (filter.includeGlobal === false) {
        return scope.kind === "project" && scope.projectId === filter.projectId;
      }
      return (
        scope.kind === "global" ||
        scope.projectId === filter.projectId
      );
    }
    if (filter.includeGlobal === true) return scope.kind === "global";
    // A tier-only filter still has no project context: search global only,
    // never every project (spec §4.1). An empty filter object returns nothing.
    if (filter.includeGlobal === undefined && filter.tier !== undefined) {
      return scope.kind === "global";
    }
    return false;
  }

  /** Resolve the tier used for filtering (public field wins, local fallback). */
  function tierOf(entry: StoredEntry): MemoryTier | undefined {
    // Narrowed to core tiers: entries saved via save() / saveWithTier() write
    // both fields, and "working" never reaches the public `tier` field.
    const publicTier = entry.tier as MemoryTier | undefined;
    return publicTier ?? entry._tier;
  }

  /** Filter by scope / tier, score lexically, keep score > 0 (spec §4.3). */
  async function queryFiltered(
    text: string,
    k: number,
    filter?: MemoryQueryFilter,
    localTier?: MemoryTier,
  ): Promise<MemoryEntry[]> {
    const tier = filter?.tier ?? localTier;
    const candidates = [...entries.values()].filter(
      (e) => matchesScope(e, filter) && (tier === undefined || tierOf(e) === tier),
    );

    // Optional embedding path: only used when every candidate has an
    // embedding; otherwise fall through to the shared lexical scorer.
    if (embedder && candidates.length > 0 && candidates.every((e) => e._embedding)) {
      try {
        const queryEmbeddings = await embedder.embed([text]);
        const queryVec = queryEmbeddings[0];
        if (queryVec) {
          return candidates
            .map((e) => ({
              entry: e,
              score: e._embedding ? cosineSimilarity(queryVec, e._embedding) : 0,
            }))
            .filter((r) => r.score > 0)
            .sort(
              (a, b) =>
                b.score - a.score ||
                (b.entry.createdAt ?? 0) - (a.entry.createdAt ?? 0),
            )
            .slice(0, k)
            .map((item) => stripInternal(item.entry));
        }
      } catch {
        // Fall through to lexical scoring
      }
    }

    return candidates
      .map((entry) => ({ entry, score: scoreMemoryText(text, entry.text) }))
      .filter((r) => r.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.entry.createdAt ?? 0) - (a.entry.createdAt ?? 0),
      )
      .slice(0, k)
      .map((r) => stripInternal(r.entry));
  }

  return {
    async save(entry: MemoryEntry): Promise<string> {
      return storeEntry(entry, entry.tier ?? defaultTier);
    },

    async saveWithTier(
      entry: Omit<MemoryEntry, "id"> & { id?: string },
      tier: MemoryTier,
    ): Promise<string> {
      return storeEntry(entry, tier);
    },

    async query(
      text: string,
      k: number = 10,
      filter?: MemoryQueryFilter,
    ): Promise<MemoryEntry[]> {
      return queryFiltered(text, k, filter);
    },

    async queryByTier(
      text: string,
      k: number,
      tier?: MemoryTier,
    ): Promise<MemoryEntry[]> {
      return queryFiltered(text, k, undefined, tier);
    },

    async delete(id: string): Promise<boolean> {
      return entries.delete(id);
    },
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/** Strip internal _tier/_embedding fields before returning to caller */
function stripInternal(entry: StoredEntry): MemoryEntry {
  const { _tier: _t, _embedding: _e, ...rest } = entry;
  void _t;
  void _e;
  return rest;
}
