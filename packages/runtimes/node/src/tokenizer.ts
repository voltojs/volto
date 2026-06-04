/**
 * Node Tokenizer — char-heuristic adapter for the Node runtime.
 * Approximates token count using character-level estimation.
 *
 * This is a lightweight adapter; production use should prefer a real
 * tokenizer (e.g., tiktoken). The char heuristic is good enough for
 * Compactor threshold decisions.
 */

import type { Tokenizer } from "@agent-core/core";

/** Default chars-per-token ratio (English text approximation) */
const DEFAULT_CHARS_PER_TOKEN = 4;

export function createNodeTokenizer(charsPerToken: number = DEFAULT_CHARS_PER_TOKEN): Tokenizer {
  return {
    count(text: string): number {
      if (text.length === 0) return 0;
      return Math.max(1, Math.ceil(text.length / charsPerToken));
    },
  };
}
