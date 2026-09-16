/**
 * Deterministic head/tail pruning of oversized tool_result text.
 * Pure — no I/O, no clocks, no randomness. The same input always produces
 * the same output, so pruned request surfaces are replayable.
 */

import type { Message } from "./state.js";

/** Join text blocks from a tool_result content array into a single string. */
function joinText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

export interface PruneToolResultOptions {
  /** Maximum code points allowed in a single tool_result text block. */
  maxChars: number;
}

/** One pruned block, reported for observability / write-back bookkeeping. */
export interface PrunedToolResult {
  toolCallId: string;
  charsBefore: number;
  charsAfter: number;
  content: string;
}

/** Share of the budget kept from the start of the text. */
const HEAD_RATIO = 0.4;
/** Share of the budget kept from the end of the text. */
const TAIL_RATIO = 0.4;

/** Unicode code-point count (not UTF-16 code units). */
function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * Head/tail cut with an explicit omission marker. Slicing by code point
 * never splits a surrogate pair. Deterministic: no locale, no clock.
 */
function pruneText(text: string, maxChars: number): string {
  const points = [...text];
  if (points.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * HEAD_RATIO);
  const tailLen = Math.floor(maxChars * TAIL_RATIO);
  const head = points.slice(0, headLen).join("");
  const tail = tailLen > 0 ? points.slice(points.length - tailLen).join("") : "";
  const omitted = points.length - headLen - tailLen;
  return `${head}… [omitted ${omitted} chars] …${tail}`;
}

/**
 * Prune every oversized text `tool_result` block on `role === "tool"`
 * messages. Non-tool messages and in-budget blocks keep their original
 * object references; the returned array is always a new array.
 */
export function pruneOversizedToolResults(
  messages: Message[],
  opts: PruneToolResultOptions,
): { messages: Message[]; pruned: PrunedToolResult[] } {
  const pruned: PrunedToolResult[] = [];
  const next = messages.map((msg) => {
    if (msg.role !== "tool") return msg;
    let changed = false;
    const content = msg.content.map((block) => {
      if (block.type !== "tool_result") return block;
      const text = joinText(block.content);
      const charsBefore = codePointLength(text);
      if (charsBefore <= opts.maxChars) return block;
      const prunedContent = pruneText(text, opts.maxChars);
      const charsAfter = codePointLength(prunedContent);
      pruned.push({
        toolCallId: block.toolUseId,
        charsBefore,
        charsAfter,
        content: prunedContent,
      });
      changed = true;
      return { ...block, content: [{ type: "text" as const, text: prunedContent }] };
    });
    if (!changed) return msg;
    return { ...msg, content };
  });
  return { messages: next, pruned };
}
