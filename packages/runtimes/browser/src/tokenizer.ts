import { createHeuristicTokenizer } from "@volto/core";
import type { Tokenizer } from "@volto/core";

/**
 * Browser adapter's tokenizer. Delegates to core's heuristic so the server-side
 * fold and the web client's continuation of it never diverge; swap this for a
 * real tokenizer (tiktoken and friends) here and both sides move together
 * only if the client is updated too — see the note in core's module.
 */
export interface BrowserTokenizerOptions {
  /** Characters per token estimate (default: 4) */
  charsPerToken?: number;
}

export function createBrowserTokenizer(opts: BrowserTokenizerOptions = {}): Tokenizer {
  return createHeuristicTokenizer(opts.charsPerToken);
}
