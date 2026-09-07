import { createHeuristicTokenizer } from "@volto/core";
import type { Tokenizer } from "@volto/core";

/**
 * Node adapter's tokenizer. Delegates to core's heuristic so the server-side
 * fold and the web client's continuation of it never diverge; swap this for a
 * real tokenizer (tiktoken and friends) here and both sides move together
 * only if the client is updated too — see the note in core's module.
 */
export function createNodeTokenizer(charsPerToken?: number): Tokenizer {
  return createHeuristicTokenizer(charsPerToken);
}
