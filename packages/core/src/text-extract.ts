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
 * Handles string content, text blocks, tool_use (as placeholder), tool_result,
 * and image (as a dimension/mediaType placeholder).
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
 * - tool_result → the result content, recursed block by block
 * - reasoning → empty string (not user-facing text)
 * - image → placeholder "[image: WxH mediaType]"
 */
export function extractBlockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "tool_use":
      return `[tool: ${block.name}]`;
    case "tool_result":
      return block.content.map(extractBlockText).join("\n");
    case "reasoning":
      // Not user-facing text: it rides in the message so the provider gets it
      // back, but it must not leak into summaries, titles or token previews.
      return "";
    case "image": {
      const dims =
        block.width !== undefined && block.height !== undefined
          ? `${block.width}x${block.height} `
          : "";
      return `[image: ${dims}${block.source.mediaType}]`;
    }
  }
}

/**
 * Per-block overhead for JSON framing/type tags. Matches context-usage.ts's
 * token-meter constants so both pricing paths agree on the same content.
 */
const BLOCK_OVERHEAD = 4;

/**
 * Token cost of an image whose dimensions are unknown. Deliberately high:
 * under-counting silently overflows the context window, over-counting only
 * compacts a little early.
 */
export const IMAGE_TOKEN_FALLBACK = 1600;

/**
 * Estimate an image's token cost from its pixel area.
 *
 * ESTIMATE ONLY — providers do not agree on image pricing (Anthropic bills
 * by area, OpenAI by tiles), and the core must not encode provider
 * differences. The authoritative number is whatever ModelEventUsage reports
 * after the call; this figure exists so the assembler and compactor can
 * budget before it. Do not "correct" it against one provider's table.
 */
export function estimateImageTokens(width?: number, height?: number): number {
  if (width === undefined || height === undefined) return IMAGE_TOKEN_FALLBACK;
  return Math.ceil((width * height) / 750);
}

/**
 * Price a single content block for token estimation. Unlike extractBlockText,
 * a reasoning block is priced the same as text: it rides in the request sent
 * to the provider, so pricing it at zero would under-estimate the prompt.
 */
export function estimateBlockTokens(block: ContentBlock, tokenizer: Tokenizer): number {
  switch (block.type) {
    case "text":
    case "reasoning":
      return tokenizer.count(block.text) + BLOCK_OVERHEAD;
    case "tool_use":
      return (
        tokenizer.count(block.name) + tokenizer.count(JSON.stringify(block.input)) + BLOCK_OVERHEAD
      );
    case "image":
      return estimateImageTokens(block.width, block.height) + BLOCK_OVERHEAD;
    case "tool_result": {
      let total = 0;
      for (const b of block.content) {
        total += estimateBlockTokens(b, tokenizer);
      }
      return total + BLOCK_OVERHEAD;
    }
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
