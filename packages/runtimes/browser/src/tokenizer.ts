/**
 * Browser Tokenizer implementation.
 * Character-count heuristic (~4 chars per token), fully portable.
 */

import type { Tokenizer } from "@volto/core";

export interface BrowserTokenizerOptions {
  /** Characters per token estimate (default: 4) */
  charsPerToken?: number;
}

export function createBrowserTokenizer(opts: BrowserTokenizerOptions = {}): Tokenizer {
  const charsPerToken = opts.charsPerToken ?? 4;

  return {
    count(text: string): number {
      return Math.ceil(text.length / charsPerToken);
    },
  };
}
