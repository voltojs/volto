/**
 * Settle-time reference resolution: inline-code spans in message text become
 * annotations only when the identity is known — the path exists on disk, or
 * exactly one file in the session's tool-touched set matches (same-turn
 * locality first). Ambiguity never guesses: an unannotated span renders as
 * plain code.
 */

import { parseFileRef } from "./parse.js";
import type { RefAnnotation, RowRefSet } from "./types.js";

export interface InlineCodeSpan {
  /** Character offsets of the code content, excluding the backticks. */
  start: number;
  end: number;
  text: string;
}

export interface ResolveRefsInput {
  rows: ReadonlyArray<{ rowKey: string; turn: string; blocks: readonly string[] }>;
  /** Files the session touched, indexed by the turn that touched them. */
  touchedByTurn: ReadonlyMap<string, readonly string[]>;
  /** Every file the session touched (project-relative). */
  touchedAll: readonly string[];
  /** Root-confined existence probe, injected by the host. */
  exists: (path: string) => Promise<boolean>;
}

const FENCE_RE = /^(`{3,}|~{3,})/;
const INLINE_CODE_RE = /`([^`\n]+)`/g;

/** Fenced regions (``` / ~~~ blocks) never contain inline code. */
function fenceRanges(markdown: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  let openAt = -1;
  let openChar = "";
  for (const line of markdown.split("\n")) {
    const m = FENCE_RE.exec(line.trimStart());
    const marker = m?.[1]?.[0] ?? "";
    if (openAt === -1 && marker !== "") {
      openAt = offset;
      openChar = marker;
    } else if (openAt !== -1 && marker === openChar) {
      ranges.push([openAt, offset + line.length]);
      openAt = -1;
    }
    offset += line.length + 1;
  }
  if (openAt !== -1) ranges.push([openAt, markdown.length]);
  return ranges;
}

export function collectInlineCodeSpans(markdown: string): InlineCodeSpan[] {
  const fences = fenceRanges(markdown);
  const spans: InlineCodeSpan[] = [];
  for (const match of markdown.matchAll(INLINE_CODE_RE)) {
    const start = (match.index ?? 0) + 1;
    const text = match[1] ?? "";
    const end = start + text.length;
    if (fences.some(([s, e]) => start >= s && start < e)) continue;
    spans.push({ start, end, text });
  }
  return spans;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export async function resolveMessageRefs(input: ResolveRefsInput): Promise<RowRefSet[]> {
  const out: RowRefSet[] = [];
  for (const row of input.rows) {
    const blockRefs: RefAnnotation[][] = [];
    for (const block of row.blocks) {
      const refs: RefAnnotation[] = [];
      for (const span of collectInlineCodeSpans(block)) {
        const parsed = parseFileRef(span.text);
        if (parsed === null) continue;
        const base: RefAnnotation = {
          start: span.start,
          end: span.end,
          path: parsed.path,
          source: "exact",
        };
        if (parsed.line !== undefined) base.line = parsed.line;
        if (parsed.endLine !== undefined) base.endLine = parsed.endLine;
        if (await input.exists(parsed.path)) {
          refs.push(base);
          continue;
        }
        const candidates = new Set(
          input.touchedAll.filter(
            (t) => t === parsed.path || t.endsWith(`/${parsed.path}`) || basename(t) === basename(parsed.path),
          ),
        );
        const local = input.touchedByTurn.get(row.turn) ?? [];
        const preferred = [...candidates].filter((c) => local.includes(c));
        const pool = preferred.length > 0 ? preferred : [...candidates];
        if (pool.length === 1 && pool[0] !== undefined) {
          refs.push({ ...base, path: pool[0], source: "session" });
        }
      }
      blockRefs.push(refs);
    }
    out.push({ rowKey: row.rowKey, blockRefs });
  }
  return out;
}
