/**
 * CharTokenizer — deterministic tokenizer for testing.
 * Uses a simple character-based heuristic: ~4 chars per token.
 * Identical input always produces identical count (no randomness).
 *
 * This is a testing utility, NOT a production tokenizer.
 */

import type { Tokenizer } from "../ports.js";
import { createHeuristicTokenizer } from "../heuristic-tokenizer.js";

/** Characters per token — tuned to approximate GPT-4 encoding ratio */
const CHARS_PER_TOKEN = 4;

/**
 * Testing alias for the production heuristic. Kept so existing tests keep
 * reading naturally; new production code should import
 * createHeuristicTokenizer directly.
 */
export function createCharTokenizer(charsPerToken?: number): Tokenizer {
  return createHeuristicTokenizer(charsPerToken);
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
