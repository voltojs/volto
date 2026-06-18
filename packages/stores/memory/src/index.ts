/**
 * In-memory SessionStore implementation.
 * Maps-based, non-persistent. Good for testing and single-session use.
 */

import type { SessionStore, SessionSnapshot } from "@volto/core";

export function createMemoryStore(): SessionStore {
  const store = new Map<string, SessionSnapshot>();

  return {
    async save(snapshot: SessionSnapshot): Promise<void> {
      store.set(snapshot.id, snapshot);
    },

    async load(id: string): Promise<SessionSnapshot | undefined> {
      return store.get(id);
    },

    async list(): Promise<SessionSnapshot[]> {
      return [...store.values()];
    },
  };
}
