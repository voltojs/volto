/**
 * Text extraction utilities — shared helpers for converting Message/ContentBlock
 * to plain text. Used by ContextAssembler, Compactor, and token estimation.
 *
 * Single source of truth to avoid divergent extractText implementations.
 */

import type { Message, ContentBlock } from "./state.js";
import type { Tokenizer } from "./ports.js";

/**
 * Extract all textual content from a message.
 * Handles string content, text blocks, tool_use (as placeholder), and tool_result.
 * ImageContent blocks are counted as empty (no text representation).
 */
export function extractMessageText(msg: Message): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    return msg.content.map(extractBlockText).join("\n");
  }
  return "";
}

/**
 * Extract text from a single content block.
 * - text → the text itself
 * - tool_use → placeholder "[tool: name]"
 * - tool_result → the result content
 * - reasoning → empty string (not user-facing text)
 * - image → empty string (no text representation)
 */
export function extractBlockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "tool_use":
      return `[tool: ${block.name}]`;
    case "tool_result":
      return block.content;
    case "reasoning":
      // Not user-facing text: it rides in the message so the provider gets it
      // back, but it must not leak into summaries, titles or token previews.
      return "";
    case "image":
      // TODO: images have no text representation; future: describe via alt text or placeholder
      return "";
  }
}

/**
 * Per-block overhead for JSON framing/type tags. Matches context-usage.ts's
 * token-meter constants so both pricing paths agree on the same content.
 */
const BLOCK_OVERHEAD = 4;

/**
 * Price a single content block for token estimation. Unlike extractBlockText,
 * a reasoning block is priced the same as text: it rides in the request sent
 * to the provider, so pricing it at zero would under-estimate the prompt.
 */
function estimateBlockTokens(block: ContentBlock, tokenizer: Tokenizer): number {
  switch (block.type) {
    case "text":
    case "reasoning":
      return tokenizer.count(block.text) + BLOCK_OVERHEAD;
    case "tool_use":
      return (
        tokenizer.count(block.name) + tokenizer.count(JSON.stringify(block.input)) + BLOCK_OVERHEAD
      );
    default:
      // tool_result, image, and any future block type: conservative
      // structural price via JSON.stringify.
      return tokenizer.count(JSON.stringify(block)) + BLOCK_OVERHEAD;
  }
}

/**
 * Estimate tokens for a message's content, per block rather than via
 * extractMessageText (which deliberately zeroes reasoning for display
 * purposes). Used by both the compactor and context-usage estimators so they
 * price the same content the same way.
 */
export function estimateContentTokens(
  content: string | readonly ContentBlock[],
  tokenizer: Tokenizer,
): number {
  if (typeof content === "string") {
    return tokenizer.count(content) + BLOCK_OVERHEAD;
  }
  let total = 0;
  for (const block of content) {
    total += estimateBlockTokens(block, tokenizer);
  }
  return total;
}

/**
 * Extract only text-type content blocks (discards tool_use, tool_result, image).
 * Used when you specifically need the "pure text" portion of a message
 * (e.g., for display or text-only analysis).
 */
export function extractPlainText(msg: Message): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
  }
  return "";
}
