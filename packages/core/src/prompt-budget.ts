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

import { estimateTokens } from "./compactor.js";
import type { ContextLayer } from "./context-assembler.js";
import type { Tokenizer } from "./ports.js";
import type { Message } from "./state.js";
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

/**
 * Proof that a provider usage measurement is the baseline for the current
 * surface. The anchor is deliberately not part of `AgentState`: it is derived
 * from the model stream, survives across per-turn Runners only because the SDK
 * shares the holder object, and is cleared whenever the surface is rewritten.
 */
export interface PromptAnchor {
  /** Provider usage of the anchored call: prompt + cache read/write + output. */
  totalTokens: number;
  /** `state.messages.length` immediately after that call's assistant message. */
  messageIndex: number;
  /** Request-header fingerprint; a mismatch invalidates the anchor. */
  headerHash: string;
  /** False when provider usage was below the full heuristic request price. */
  trusted: boolean;
}

/** Mutable holder shared by the per-turn Runners of one agent instance. */
export interface PromptAnchorState {
  anchor?: PromptAnchor;
}

/**
 * Current prompt pressure from a trusted anchor plus the messages appended
 * after the anchored call. Returns `undefined` when the anchor is missing,
 * untrusted, or stale (the message surface shrank underneath it), so the
 * caller falls back to the absolute estimate.
 */
export function estimateFromAnchor(
  anchor: PromptAnchor | undefined,
  messages: readonly Message[],
  tokenizer: Tokenizer,
): number | undefined {
  if (anchor === undefined || !anchor.trusted) return undefined;
  if (!Number.isInteger(anchor.messageIndex) || anchor.messageIndex < 0) return undefined;
  if (anchor.messageIndex > messages.length) return undefined;
  return anchor.totalTokens + estimateTokens(messages.slice(anchor.messageIndex), tokenizer);
}
