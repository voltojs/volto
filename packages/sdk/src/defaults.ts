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
 */

import type { Clock, Id, Random, Tokenizer, SessionStore, EventSink } from "@agent-core/core";
import { createMemoryStore } from "@agent-core/store-memory";

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

/** Simple character-count tokenizer (~4 chars per token, common heuristic) */
export const defaultTokenizer: Tokenizer = {
  count: (text: string) => Math.ceil(text.length / 4),
};

export const defaultEventSink: EventSink = {
  emit: () => {},
};

export function createDefaultSessionStore(): SessionStore {
  return createMemoryStore();
}
