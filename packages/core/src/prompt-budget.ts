/**
 * Prompt-budget helpers shared by the Runner's compaction decision.
 *
 * The provider usage anchor covers the static prefix and tool schemas on
 * every call after the first. These estimators price the same surface for the
 * no-anchor fallback: a fresh conversation, a rebuild/resume, or the call
 * immediately after compaction/pruning cleared the anchor.
 *
 * @module prompt-budget
 */

import type { ContextLayer } from "./context-assembler.js";
import type { Tokenizer } from "./ports.js";
import type { ToolDefinition } from "./tool.js";

/**
 * Price the host-resolved static context layers (AGENTS.md, skill catalogue,
 * memory preloads). Layer text is serialized verbatim by the assembler, so a
 * plain text count is the right unit.
 */
export function estimateContextLayerTokens(
  layers: readonly ContextLayer[],
  tokenizer: Tokenizer,
): number {
  let total = 0;
  for (const layer of layers) total += tokenizer.count(layer.text);
  return total;
}

/**
 * Price the tool-schema slice of the request envelope. Only the fields the
 * model actually receives are counted; `requires`/`riskTier`/`pathInputs`
 * stay host-side.
 */
export function estimateToolDefinitionTokens(
  tools: readonly ToolDefinition[],
  tokenizer: Tokenizer,
): number {
  let total = 0;
  for (const tool of tools) {
    total += tokenizer.count(
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }),
    );
  }
  return total;
}
