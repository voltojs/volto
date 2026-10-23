/**
 * Deterministic head/tail pruning of oversized tool_result text.
 * Pure — no I/O, no clocks, no randomness. The same input always produces
 * the same output, so pruned request surfaces are replayable.
 */

import type { Message, ToolResultBlock } from "./state.js";

export interface PruneToolResultOptions {
  /** Maximum code points allowed in a single tool_result text block. */
  maxChars: number;
  /** Leading code points kept; default floor(maxChars * 0.5). */
  headChars?: number;
  /** Trailing code points kept; default floor(maxChars * 0.125). */
  tailChars?: number;
}

/** One pruned block, reported for observability / write-back bookkeeping. */
export interface PrunedToolResult {
  toolCallId: string;
  charsBefore: number;
  charsAfter: number;
  /**
   * The full post-prune block array — images ride through untouched, so
   * this cannot be a plain string. The reducer normalizes it on write-back.
   */
  content: ToolResultBlock[];
}

/** Share of the budget kept from the start of the text (DSH: 50%). */
const HEAD_RATIO = 0.5;
/** Share of the budget kept from the end of the text (DSH: 12.5%). */
const TAIL_RATIO = 0.125;
/** Unicode code-point count (not UTF-16 code units). */
function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * Head/tail cut with an explicit omission marker. Slicing by code point
 * never splits a surrogate pair. Deterministic: no locale, no clock.
 */
function pruneText(
  text: string,
  maxChars: number,
  headChars: number,
  tailChars: number,
): string | undefined {
  const points = [...text];
  if (points.length <= maxChars) return text;
  const headLen = Math.min(headChars, points.length);
  const tailLen = Math.min(tailChars, points.length - headLen);
  const head = points.slice(0, headLen).join("");
  const tail = tailLen > 0 ? points.slice(points.length - tailLen).join("") : "";
  const omitted = points.length - headLen - tailLen;
  const cut = `${head}… [omitted ${omitted} chars] …${tail}`;
  // A tiny threshold cannot fit the marker. Shrinking is the contract; if the
  // marked result would be longer than the input, leave the block untouched
  // rather than grow the prompt.
  return codePointLength(cut) <= maxChars ? cut : undefined;
}

/** Total code points across the text blocks of a tool_result content array. */
function textChars(content: readonly ToolResultBlock[]): number {
  let n = 0;
  for (const b of content) {
    if (b.type === "text" || b.type === "structured") n += codePointLength(b.text);
  }
  return n;
}

/** Validate and default a prune budget. Throws on a configuration that can never shrink. */
export function resolvePruneOptions(opts: PruneToolResultOptions): {
  maxChars: number;
  headChars: number;
  tailChars: number;
} {
  const maxChars = opts.maxChars;
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error("pruneOversizedToolResults: maxChars must be a positive integer");
  }
  const headChars = opts.headChars ?? Math.floor(maxChars * HEAD_RATIO);
  const tailChars = opts.tailChars ?? Math.floor(maxChars * TAIL_RATIO);
  if (!Number.isInteger(headChars) || !Number.isInteger(tailChars) || headChars < 0 || tailChars < 0) {
    throw new Error("pruneOversizedToolResults: headChars/tailChars must be non-negative integers");
  }
  if (headChars + tailChars >= maxChars) {
    throw new Error(
      "pruneOversizedToolResults: headChars + tailChars must leave room for the omission marker",
    );
  }
  return { maxChars, headChars, tailChars };
}

/**
 * Prune every oversized text block inside `tool_result` content on
 * `role === "tool"` messages. Non-tool messages and in-budget blocks keep
 * their original object references; the returned array is always a new array.
 *
 * Only text-bearing blocks answer to the character budget: a text block is
 * cut head/tail in place; an oversized structured block degrades to an
 * equivalent plain text block (its cut projection is no longer honest
 * structured data) and is cut the same way. An image's cost is fixed by its
 * pixel area, so truncating it saves nothing and dropping it would waste the
 * tool call that produced it. Image blocks are preserved as-is.
 */
export function pruneOversizedToolResults(
  messages: Message[],
  opts: PruneToolResultOptions,
): { messages: Message[]; pruned: PrunedToolResult[] } {
  const { maxChars, headChars, tailChars } = resolvePruneOptions(opts);
  const pruned: PrunedToolResult[] = [];
  const next = messages.map((msg) => {
    if (msg.role !== "tool") return msg;
    let changed = false;
    const content = msg.content.map((block) => {
      if (block.type !== "tool_result") return block;
      let blockChanged = false;
      const budgeted = block.content.map((b) => {
        if (b.type === "text") {
          if (codePointLength(b.text) <= maxChars) return b;
          const cut = pruneText(b.text, maxChars, headChars, tailChars);
          if (cut === undefined) return b;
          blockChanged = true;
          return { ...b, text: cut };
        }
        if (b.type === "structured") {
          if (codePointLength(b.text) <= maxChars) return b;
          const cut = pruneText(b.text, maxChars, headChars, tailChars);
          if (cut === undefined) return b;
          blockChanged = true;
          // Post-cut data would be incomplete, so keeping the structured
          // shell would lie — degrade to an equivalent plain text block
          // carrying the (cut) projection, then apply the same head/tail
          // cut as text blocks.
          return { type: "text" as const, text: cut };
        }
        return b;
      });
      if (!blockChanged) return block;
      pruned.push({
        toolCallId: block.toolUseId,
        charsBefore: textChars(block.content),
        charsAfter: textChars(budgeted),
        content: budgeted,
      });
      changed = true;
      return { ...block, content: budgeted };
    });
    if (!changed) return msg;
    return { ...msg, content };
  });
  return { messages: next, pruned };
}
