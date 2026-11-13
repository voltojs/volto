import { createHeuristicTokenizer } from "@voltojs/core";
import type { Tokenizer } from "@voltojs/core";

/**
 * Node adapter's tokenizer. Delegates to core's heuristic so the server-side
 * fold and the web client's continuation of it never diverge; swap this for a
 * real tokenizer (tiktoken and friends) here and both sides move together
 * only if the client is updated too — see the note in core's module.
 */
export function createNodeTokenizer(bytesPerToken?: number): Tokenizer {
  return createHeuristicTokenizer(bytesPerToken);
}
