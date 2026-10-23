/**
 * Fixed-density heuristic tokenizer — the production default when no exact
 * tokenizer is injected through the Tokenizer port.
 *
 * This is the single source of the bytes-per-token heuristic: the node
 * runtime adapter and the web app both delegate here, so the server's fold
 * and the client's continuation of it price identical text identically. A
 * second copy of the formula anywhere else is a silent divergence waiting to
 * happen.
 *
 * The unit is UTF-8 bytes, not UTF-16 code units. Measuring code units made a
 * CJK character (3 UTF-8 bytes) look like 0.25 token while an ASCII character
 * looked like 0.25 token too, systematically undercounting non-Latin text.
 * ASCII is unchanged because one ASCII character is one byte.
 */

import type { Tokenizer } from "./ports.js";

/** UTF-8 bytes per token — approximates the GPT-4 encoding ratio. */
const BYTES_PER_TOKEN = 4;

const UTF8 = new TextEncoder();

export function createHeuristicTokenizer(bytesPerToken: number = BYTES_PER_TOKEN): Tokenizer {
  return {
    count(text: string): number {
      if (text.length === 0) return 0;
      return Math.max(1, Math.ceil(UTF8.encode(text).length / bytesPerToken));
    },
  };
}
