/**
 * Default port implementations for the SDK.
 *
 * Provides sensible defaults so that createAgent() requires only a ModelPort:
 * - Clock: real Date.now()
 * - Id: crypto.randomUUID()
 * - Random: Math.random()
 * - Tokenizer: character-count heuristic
 * - SessionStore: in-memory (no persistence)
 * - EventSink: no-op
 * - M8 ports: no-op / in-memory / throw-if-called defaults
 */

import type {
  Clock,
  Id,
  Random,
  Tokenizer,
  SessionStore,
  TranscriptStore,
  EventSink,
  ToolSource,
  MemoryStore,
  MemoryEntry,
  MemoryQueryFilter,
  Embedder,
  Telemetry,
  TelemetrySpan,
  Cache,
  Sandbox,
  SandboxEvent,
  Secrets,
  Scheduler,
  PolicyEngine,
} from "@voltojs/core";
import { createHeuristicTokenizer } from "@voltojs/core";
import { createMemoryStore } from "@voltojs/store-memory";

let idCounter = 0;

export const defaultClock: Clock = {
  now: () => Date.now(),
};

export const defaultId: Id = {
  next: () => {
    idCounter++;
    return `id-${idCounter}-${defaultClock.now()}`;
  },
};

export const defaultRandom: Random = {
  next: () => Math.random(),
};

/**
 * SDK default tokenizer. Delegates to core's single-source heuristic so the
 * server-side fold and the web client's continuation of it never diverge.
 */
export const defaultTokenizer: Tokenizer = createHeuristicTokenizer();

export const defaultEventSink: EventSink = {
  emit: () => {},
};

export function createDefaultSessionStore(): SessionStore {
  return createMemoryStore();
}

export const defaultChatStore: TranscriptStore = {
  async appendEvents() {},
};

// ──────────────────────────────────────────────
// M8: New port defaults
// ──────────────────────────────────────────────

/** Empty tool source — no dynamic tools by default */
export const defaultToolSource: ToolSource = {
  async list() {
    return [];
  },
};

/** In-memory MemoryStore — Map-based, non-persistent */
export function createDefaultMemoryStore(): MemoryStore {
  const entries = new Map<string, MemoryEntry>();

  return {
    async save(entry: MemoryEntry): Promise<string> {
      entries.set(entry.id, entry);
      return entry.id;
    },

    async query(
      _text: string,
      k: number = 10,
      filter?: MemoryQueryFilter,
    ): Promise<MemoryEntry[]> {
      // Naive: return all entries (no vector similarity without an Embedder).
      // A scoped query must never leak entries across scopes, and this inert
      // default cannot honor scope/tier semantics — so a filtered query
      // (including an empty filter object) returns nothing, per the
      // MemoryStore contract (spec 2026-10-20 memory-rag §4.1). Hosts that
      // enable memory features must inject a real MemoryStore.
      if (filter !== undefined) return [];
      return [...entries.values()].slice(0, k);
    },

    async delete(id: string): Promise<boolean> {
      return entries.delete(id);
    },
  };
}

/** No-op embedder — throws if actually called; inject a real one for RAG */
export const defaultEmbedder: Embedder = {
  embed(): Promise<number[][]> {
    return Promise.reject(
      new Error("No Embedder configured. Inject a real Embedder via createAgent({ embedder }) to use embedding features."),
    );
  },
};

/** No-op telemetry — spans and metrics do nothing */
export const defaultTelemetry: Telemetry = {
  startSpan(): TelemetrySpan {
    return {
      setAttribute(): void {},
      end(): void {},
    };
  },

  metric(): void {},
};

/** In-memory cache with optional TTL */
export function createDefaultCache(): Cache {
  const store = new Map<string, { value: unknown; expiresAt?: number }>();

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.value as T;
    },

    async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
      store.set(key, {
        value,
        expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined,
      });
    },

    async delete(key: string): Promise<boolean> {
      return store.delete(key);
    },
  };
}

/** Default sandbox — throws; inject a real implementation for isolated execution */
export const defaultSandbox: Sandbox = {
  run(): AsyncIterable<SandboxEvent> {
    throw new Error(
      "No Sandbox configured. Inject a real Sandbox via createAgent({ sandbox }) to use sandbox features.",
    );
  },
};

/** Default secrets — always returns undefined (no secrets configured) */
export const defaultSecrets: Secrets = {
  async resolve(): Promise<string | undefined> {
    return undefined;
  },
};

/** No-op scheduler — sleep resolves immediately, schedule is fire-and-forget */
let schedulerCounter = 0;
export const defaultScheduler: Scheduler = {
  async schedule(): Promise<string> {
    return `sched-${++schedulerCounter}`;
  },

  async cancel(): Promise<boolean> {
    return false;
  },

  async sleep(): Promise<void> {
    // No-op: resolves immediately
  },
};

/** Allow-all policy engine — grants every request */
export const defaultPolicyEngine: PolicyEngine = {
  async evaluate(): Promise<"allow" | "deny" | "ask"> {
    return "allow";
  },
};
