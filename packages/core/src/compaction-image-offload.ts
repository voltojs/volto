/**
 * Compaction image offload — pure planning for preserving images across a
 * compaction write-back (spec 2026-10-16-compaction-image-offload, D1/D3).
 *
 * Same discipline as tool-result-spill: the core decides WHAT survives, the
 * Runner performs `AttachmentStore.put` and feeds the resolved ref blocks
 * back via the extended `compaction_applied` input. No I/O, no clock, no
 * randomness — the same replaced span always yields the same plan, so replay
 * stays byte-identical (D4).
 */

import type { ContentBlock, ImageContent, Message } from "./state.js";
import type { ToolResultBlock } from "./state.js";

/** One image block found in the replaced span, with its source addressed. */
export interface OffloadCandidate {
  /** Id of the message the block was collected from. */
  messageId: string;
  /** Index of the image block within its containing array (message content
   *  or the enclosing tool_result's content). */
  blockIndex: number;
  /**
   * Container-path suffix for deterministic id derivation. `blockIndex` is
   * container-local, so a tool_result image and a top-level image in the
   * same message can share an index; the suffix carries the nesting so the
   * derived ids never collide: `t<blockIndex>` for top-level blocks,
   * `r<outerBlockIndex>-<innerBlockIndex>` for tool_result-nested ones.
   */
  idSuffix: string;
  source:
    | { type: "base64"; data: string; mediaType: string }
    | { type: "ref"; id: string; mediaType: string };
  width?: number;
  height?: number;
}

/** The pure compaction image plan for one replaced span. */
export interface ImageOffloadPlan {
  /** Inline base64 images (bytes must be put to store). D1 path 2. */
  toOffload: OffloadCandidate[];
  /**
   * Ref blocks to attach to the summary, capped to the last `maxImages`
   * (D3). Existing refs keep their id; inline base64 candidates appear as
   * ref-shaped blocks with the placeholder id `"pending"` — the Runner
   * replaces that id with the store key after its `put` succeeds
   * (Task 2 composes the final list).
   */
  preserved: ContentBlock[];
  /**
   * Images beyond the cap, degraded to today's placeholder text
   * (`[image: WxH mediaType]`, byte-identical to extractBlockText's image
   * case), joined with `\n` in original order.
   */
  droppedPlaceholders: string;
}

/** Collect every image block reachable from a content array, in order,
 *  recursing into tool_result content exactly like extractBlockText.
 *  `path` prefixes idSuffixes: "t" for the top-level array, "r<outer>-"
 *  inside a tool_result, so nested and top-level indices never collide. */
function collectImages(
  blocks: readonly (ContentBlock | ToolResultBlock)[],
  messageId: string,
  path: string,
  out: OffloadCandidate[],
): void {
  for (const [index, block] of blocks.entries()) {
    if (block.type === "image") {
      out.push({
        messageId,
        blockIndex: index,
        idSuffix: `${path}${index}`,
        source: block.source as OffloadCandidate["source"],
        ...(block.width !== undefined ? { width: block.width } : {}),
        ...(block.height !== undefined ? { height: block.height } : {}),
      });
    } else if (block.type === "tool_result") {
      collectImages(block.content, messageId, `r${index}-`, out);
    }
  }
}

/** The dims segment shared by placeholders and markers: `WxH ` only when
 *  both dimensions are known, else empty — same rule as extractBlockText. */
function dimsSegment(meta: { width?: number; height?: number }): string {
  return meta.width !== undefined && meta.height !== undefined
    ? `${meta.width}x${meta.height} `
    : "";
}

/**
 * Plan which images survive a compaction, purely. Collects every image block
 * from `replaced` in original message order (top-level blocks AND blocks
 * nested in tool_result content arrays), then:
 *
 * - the LAST `maxImages` candidates become `preserved` ref blocks (inline
 *   base64 ones get the placeholder id `"pending"`, resolved by the Runner
 *   after put); older ones degrade to `droppedPlaceholders`.
 * - `toOffload` holds the inline base64 candidates that survive the cap —
 *   offloading bytes for a dropped image would be unreferenced storage, so
 *   `maxImages <= 0` yields an empty `toOffload` too, i.e. full fallback to
 *   today's behavior (all placeholders, no put).
 */
export function planImageOffload(
  replaced: Message[],
  opts: { maxImages: number },
): ImageOffloadPlan {
  const candidates: OffloadCandidate[] = [];
  for (const msg of replaced) {
    if (Array.isArray(msg.content)) {
      collectImages(msg.content, msg.id, "t", candidates);
    }
  }

  const placeholderOf = (c: OffloadCandidate): string =>
    `[image: ${dimsSegment(c)}${c.source.mediaType}]`;

  const keepFrom = Math.max(0, candidates.length - opts.maxImages);
  const kept = candidates.slice(keepFrom);
  const dropped = candidates.slice(0, keepFrom);

  const preserved: ContentBlock[] = kept.map((c) => {
    const source =
      c.source.type === "ref"
        ? c.source
        : ({ type: "ref", id: "pending", mediaType: c.source.mediaType } as const);
    return {
      type: "image",
      source,
      ...(c.width !== undefined ? { width: c.width } : {}),
      ...(c.height !== undefined ? { height: c.height } : {}),
    } as ImageContent;
  });

  const toOffload = opts.maxImages <= 0 ? [] : kept.filter((c) => c.source.type === "base64");

  return {
    toOffload,
    preserved: opts.maxImages <= 0 ? [] : preserved,
    droppedPlaceholders: dropped.map(placeholderOf).join("\n"),
  };
}

/**
 * The per-image marker line placed before each preserved ref block in the
 * summary message (D5). Verbatim format — keep it byte-identical:
 * `[image preserved from compressed conversation: WxH mediaType]`
 * (dims segment omitted unless both dimensions are known).
 */
export function renderImagePreservedMarker(meta: {
  width?: number;
  height?: number;
  mediaType: string;
}): string {
  return `[image preserved from compressed conversation: ${dimsSegment(meta)}${meta.mediaType}]`;
}
