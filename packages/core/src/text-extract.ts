/**
 * Text extraction utilities — shared helpers for converting Message/ContentBlock
 * to plain text. Used by ContextAssembler, Compactor, and token estimation.
 *
 * Single source of truth to avoid divergent extractText implementations.
 */

import type { Message, ContentBlock } from "./state.js";

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
    case "image":
      // TODO: images have no text representation; future: describe via alt text or placeholder
      return "";
  }
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
