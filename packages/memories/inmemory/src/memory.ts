/**
 * In-memory layered MemoryStore implementation.
 *
 * Implements the M8 `MemoryStore` port with three tiers:
 * - working: current session window (short-lived, by convention managed by state.messages)
 * - episodic: per-session/time turn summaries (medium-term)
 * - semantic: embedding-indexed long-term facts (long-term)
 *
 * Tier is expressed via entry metadata (not a port signature change).
 * Semantic layer requires an `Embedder` for vector similarity search.
 */

import type { MemoryStore, MemoryEntry, Embedder } from "@volto/core";

export type MemoryTier = "working" | "episodic" | "semantic";

export interface InMemoryMemoryStoreOptions {
  /** Embedder for semantic layer similarity search */
  embedder?: Embedder;
  /** Default tier for save operations (default: "semantic") */
  defaultTier?: MemoryTier;
}

export function createInMemoryMemoryStore(
  opts: InMemoryMemoryStoreOptions = {},
): MemoryStore & {
  /** Query by tier (optional filter) */
  queryByTier(text: string, k: number, tier?: MemoryTier): Promise<MemoryEntry[]>;
  /** Save with explicit tier */
  saveWithTier(entry: Omit<MemoryEntry, "id"> & { id?: string }, tier: MemoryTier): Promise<string>;
} {
  const { embedder, defaultTier = "semantic" } = opts;
  const entries = new Map<string, MemoryEntry & { _tier?: MemoryTier; _embedding?: number[] }>();
  let idCounter = 0;

  function generateId(): string {
    idCounter++;
    return `mem-${idCounter}-${Date.now()}`;
  }

  return {
    async save(entry: MemoryEntry): Promise<string> {
      const id = entry.id || generateId();
      const stored = { ...entry, id, _tier: defaultTier } as MemoryEntry & { _tier?: MemoryTier; _embedding?: number[] };
      entries.set(id, stored);

      // Compute embedding for semantic layer if embedder is available
      if (defaultTier === "semantic" && embedder && entry.text) {
        try {
          const embeddings = await embedder.embed([entry.text]);
          if (embeddings[0]) {
            stored._embedding = embeddings[0];
          }
        } catch {
          // Embedding failure is non-fatal — entry is still saved
        }
      }

      return id;
    },

    async saveWithTier(
      entry: Omit<MemoryEntry, "id"> & { id?: string },
      tier: MemoryTier,
    ): Promise<string> {
      const id = entry.id || generateId();
      const stored = { ...entry, id, _tier: tier } as MemoryEntry & { _tier?: MemoryTier; _embedding?: number[] };
      entries.set(id, stored);

      if (tier === "semantic" && embedder && entry.text) {
        try {
          const embeddings = await embedder.embed([entry.text]);
          if (embeddings[0]) {
            stored._embedding = embeddings[0];
          }
        } catch {
          // Non-fatal
        }
      }

      return id;
    },

    async query(text: string, k: number = 10): Promise<MemoryEntry[]> {
      const allEntries = [...entries.values()];

      // If embedder is available, use cosine similarity for ranking
      if (embedder && allEntries.some((e) => e._embedding)) {
        try {
          const queryEmbeddings = await embedder.embed([text]);
          const queryVec = queryEmbeddings[0];
          if (queryVec) {
            return allEntries
              .map((e) => ({
                entry: e,
                score: e._embedding ? cosineSimilarity(queryVec, e._embedding) : 0,
              }))
              .sort((a, b) => b.score - a.score)
              .slice(0, k)
              .map((item) => stripInternal(item.entry as MemoryEntry & { _tier?: MemoryTier; _embedding?: number[] }));
          }
        } catch {
          // Fall through to naive retrieval
        }
      }

      // Naive: return all entries (most recent first by insertion order)
      return allEntries
        .slice(-k)
        .reverse()
        .map((e) => stripInternal(e as MemoryEntry & { _tier?: MemoryTier; _embedding?: number[] }));
    },

    async queryByTier(text: string, k: number, tier?: MemoryTier): Promise<MemoryEntry[]> {
      const filtered = [...entries.values()].filter(
        (e) => !tier || e._tier === tier,
      );

      if (embedder && filtered.some((e) => e._embedding)) {
        try {
          const queryEmbeddings = await embedder.embed([text]);
          const queryVec = queryEmbeddings[0];
          if (queryVec) {
            return filtered
              .map((e) => ({
                entry: e,
                score: e._embedding ? cosineSimilarity(queryVec, e._embedding) : 0,
              }))
              .sort((a, b) => b.score - a.score)
              .slice(0, k)
              .map((item) => stripInternal(item.entry as MemoryEntry & { _tier?: MemoryTier; _embedding?: number[] }));
          }
        } catch {
          // Fall through
        }
      }

      return filtered.slice(-k).reverse().map((e) => stripInternal(e as MemoryEntry & { _tier?: MemoryTier; _embedding?: number[] }));
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
function stripInternal(entry: MemoryEntry & { _tier?: MemoryTier; _embedding?: number[] }): MemoryEntry {
  const { _tier: _t, _embedding: _e, ...rest } = entry;
  void _t;
  void _e;
  return rest;
}
