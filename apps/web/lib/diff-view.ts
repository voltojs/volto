/**
 * Parses the unified hunk body a write tool captured (`fileChange.diff`).
 *
 * The producer is `@volto/tools-common`'s `computeUnifiedDiff`, so the format
 * is the small, self-consistent one it emits: `@@ -a,b +c,d @@` headers and
 * ` `/`+`/`-` prefixed lines. Every emitted line is rendered with both line
 * numbers, so a removed line still points at where it *was* and an added line
 * at where it *is*.
 *
 * Pure: text in, rows out.
 */

export type DiffRowKind = 'hunk' | 'context' | 'add' | 'remove';

export interface DiffRow {
  kind: DiffRowKind;
  /** Line content without the diff prefix (empty for a hunk header). */
  text: string;
  /** Old-side line number; absent on added lines and hunk headers. */
  oldLine?: number;
  /** New-side line number; absent on removed lines and hunk headers. */
  newLine?: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * One hunk body as rendering rows. Unknown lines are skipped rather than
 * rendered as context — a cut-off or hand-edited body must not fabricate
 * line numbers.
 */
export function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const raw of diff.split('\n')) {
    if (raw === '') continue;
    const header = HUNK_HEADER.exec(raw);
    if (header !== null) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      rows.push({ kind: 'hunk', text: raw });
      continue;
    }
    const prefix = raw[0];
    const text = raw.slice(1);
    if (prefix === '+') {
      rows.push({ kind: 'add', text, newLine });
      newLine += 1;
    } else if (prefix === '-') {
      rows.push({ kind: 'remove', text, oldLine });
      oldLine += 1;
    } else if (prefix === ' ') {
      rows.push({ kind: 'context', text, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return rows;
}