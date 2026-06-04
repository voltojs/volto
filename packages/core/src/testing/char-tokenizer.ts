/**
 * CharTokenizer — deterministic tokenizer for testing.
 * Uses a simple character-based heuristic: ~4 chars per token.
 * Identical input always produces identical count (no randomness).
 *
 * This is a testing utility, NOT a production tokenizer.
 */

import type { Tokenizer } from "../ports.js";

/** Characters per token — tuned to approximate GPT-4 encoding ratio */
const CHARS_PER_TOKEN = 4;

export function createCharTokenizer(charsPerToken: number = CHARS_PER_TOKEN): Tokenizer {
  return {
    count(text: string): number {
      if (text.length === 0) return 0;
      return Math.max(1, Math.ceil(text.length / charsPerToken));
    },
  };
}

/**
 * A fixed-rate tokenizer that always returns a predetermined count per call.
 * Useful for testing compactor thresholds with precise control.
 */
export function createFixedTokenizer(tokensPerCall: number): Tokenizer {
  return {
    count(): number {
      return tokensPerCall;
    },
  };
}

/**
 * A tokenizer that maps specific strings to specific token counts.
 * Unmapped strings fall back to char-based heuristic.
 */
export function createMappedTokenizer(
  mappings: Record<string, number>,
  fallbackCharsPerToken: number = CHARS_PER_TOKEN,
): Tokenizer {
  const fallback = createCharTokenizer(fallbackCharsPerToken);
  return {
    count(text: string): number {
      if (text in mappings) return mappings[text]!;
      return fallback.count(text);
    },
  };
}
