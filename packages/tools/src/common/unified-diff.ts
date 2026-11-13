/**
 * Pure unified-diff generation for tool-side change capture.
 *
 * A write tool is the only place that holds both the before and after text of
 * an edit, so it is where the change must be described. The result rides
 * `ToolResult.displayMetadata` (the layer AGENTS.md reserves for diffs and
 * line counts), which the reducer persists with the tool_result event — the
 * web therefore gets the exact per-edit diff on a cold load, a replayed log,
 * and a sub-agent transcript alike, with no server call and no dependency on
 * the project being a git repository.
 *
 * No I/O, no clock, no randomness: the same two strings always produce the
 * same diff (replay discipline).
 */

/** Context lines kept around each change (git's default). */
const CONTEXT_LINES = 3;

/**
 * Cap on the serialised diff body. It is persisted in the transcript event,
 * so rewriting one large generated file must not balloon the session log.
 * Exceeding the cap is declared (`truncated: true`), never silent.
 */
export const MAX_DIFF_CHARS = 20_000;

/**
 * Upper bound on the Myers edit distance before the middle section degrades to
 * a coarse "everything removed, everything added" hunk. Trimming the common
 * prefix/suffix first keeps ordinary edits far below this; the bound exists so
 * two large unrelated files cannot blow up memory.
 */
const MAX_EDIT_DISTANCE = 500;

export interface UnifiedDiff {
  /** Hunk body: `@@` headers plus ` `/`+`/`-` lines. Empty when nothing changed. */
  diff: string;
  additions: number;
  deletions: number;
  /** True when the body hit `MAX_DIFF_CHARS` and is cut short. */
  truncated: boolean;
}

type LineKind = "equal" | "remove" | "add";

interface Op {
  kind: LineKind;
  text: string;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  ops: Op[];
}

/**
 * Splits text into lines without inventing a phantom trailing line for a
 * trailing newline: "a\n" is one line, "a\n\n" is two. A lone "" is zero
 * lines, so creating a file is a pure addition hunk.
 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n");
}

/**
 * Longest-common-subsequence line diff. Common prefix/suffix are matched
 * up front and the middle is diffed with Myers' O((N+M)D) algorithm, keeping
 * backtracking state per edit-distance step.
 */
function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix += 1;
  let endA = n;
  let endB = m;
  while (endA > prefix && endB > prefix && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const ops: Op[] = [];
  for (let i = 0; i < prefix; i += 1) ops.push({ kind: "equal", text: a[i]! });
  const middleA = a.slice(prefix, endA);
  const middleB = b.slice(prefix, endB);
  ops.push(...diffMiddle(middleA, middleB));
  for (let i = endA; i < n; i += 1) ops.push({ kind: "equal", text: a[i]! });
  return ops;
}

function diffMiddle(a: string[], b: string[]): Op[] {
  if (a.length === 0) return b.map((text) => ({ kind: "add" as const, text }));
  if (b.length === 0) return a.map((text) => ({ kind: "remove" as const, text }));

  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = limit;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d, offset);
    }
  }

  // Beyond the distance cap: describe the whole middle as one replacement.
  return [
    ...a.map((text) => ({ kind: "remove" as const, text })),
    ...b.map((text) => ({ kind: "add" as const, text })),
  ];
}

function backtrack(
  trace: readonly Int32Array[],
  a: string[],
  b: string[],
  distance: number,
  offset: number,
): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = distance; d > 0; d -= 1) {
    const v = trace[d]!;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "equal", text: a[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push({ kind: "add", text: b[y - 1]! });
      y -= 1;
    } else {
      ops.push({ kind: "remove", text: a[x - 1]! });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: "equal", text: a[x - 1]! });
    x -= 1;
    y -= 1;
  }
  ops.reverse();
  return ops;
}

/**
 * Groups the op sequence into hunks with `CONTEXT_LINES` of context, merging
 * changes that would otherwise produce overlapping hunks.
 */
function buildHunks(ops: readonly Op[]): Hunk[] {
  const changed: number[] = [];
  ops.forEach((op, index) => {
    if (op.kind !== "equal") changed.push(index);
  });
  if (changed.length === 0) return [];

  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(ops.length, index + CONTEXT_LINES + 1);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && start <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  // Line numbers at every op boundary; op i starts at old/new line N (1-based).
  const oldBefore = new Array<number>(ops.length + 1);
  const newBefore = new Array<number>(ops.length + 1);
  let oldLine = 1;
  let newLine = 1;
  for (let i = 0; i < ops.length; i += 1) {
    oldBefore[i] = oldLine;
    newBefore[i] = newLine;
    if (ops[i]!.kind !== "add") oldLine += 1;
    if (ops[i]!.kind !== "remove") newLine += 1;
  }
  oldBefore[ops.length] = oldLine;
  newBefore[ops.length] = newLine;

  return ranges.map(({ start, end }) => {
    const slice = ops.slice(start, end);
    const oldLines = slice.filter((op) => op.kind !== "add").length;
    const newLines = slice.filter((op) => op.kind !== "remove").length;
    // Git's convention for an empty side: a pure insertion starts at `-0,0`
    // rather than pointing at the line it lands after.
    return {
      oldStart: oldLines === 0 ? oldBefore[start]! - 1 : oldBefore[start]!,
      oldLines,
      newStart: newLines === 0 ? newBefore[start]! - 1 : newBefore[start]!,
      newLines,
      ops: slice,
    };
  });
}

function hunkHeader(hunk: Hunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

const PREFIX: Record<LineKind, string> = { equal: " ", remove: "-", add: "+" };

/**
 * Unified diff of two texts. Returns an empty body when nothing changed
 * (including a pure trailing-newline difference, which carries no line
 * content and would render as a no-op hunk).
 */
export function computeUnifiedDiff(before: string, after: string): UnifiedDiff {
  const ops = diffOps(splitLines(before), splitLines(after));
  const additions = ops.filter((op) => op.kind === "add").length;
  const deletions = ops.filter((op) => op.kind === "remove").length;
  const hunks = buildHunks(ops);

  const lines: string[] = [];
  for (const hunk of hunks) {
    lines.push(hunkHeader(hunk));
    for (const op of hunk.ops) lines.push(`${PREFIX[op.kind]}${op.text}`);
  }

  // Cut on a line boundary so every emitted line stays parseable.
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (used + cost > MAX_DIFF_CHARS) break;
    kept.push(line);
    used += cost;
  }
  return {
    diff: kept.join("\n"),
    additions,
    deletions,
    truncated: kept.length < lines.length,
  };
}