/**
 * Fixed-density heuristic tokenizer — the production default when no exact
 * tokenizer is injected through the Tokenizer port.
 *
 * This is the single source of the chars-per-token heuristic: the node
 * runtime adapter and the web app both delegate here, so the server's fold
 * and the client's continuation of it price identical text identically. A
 * second copy of the formula anywhere else is a silent divergence waiting to
 * happen.
 */

import type { Tokenizer } from "./ports.js";

/** Characters per token — approximates the GPT-4 encoding ratio. */
const CHARS_PER_TOKEN = 4;

export function createHeuristicTokenizer(charsPerToken: number = CHARS_PER_TOKEN): Tokenizer {
  return {
    count(text: string): number {
      if (text.length === 0) return 0;
      return Math.max(1, Math.ceil(text.length / charsPerToken));
    },
  };
}
