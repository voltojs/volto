/**
 * Spill decision for oversized tool results — pure, no I/O, no clocks.
 * The same input always produces the same decision, so spill runs stay
 * replayable and snapshot-testable.
 */

/** Threshold + head sizing inputs for {@link decideSpill}. */
export interface SpillDecisionOptions {
  /** Code-point count at or below which the text passes through untouched. */
  thresholdChars: number;
  /** Code points kept from the start of the text when a spill happens. */
  headChars: number;
}

/** The spill verdict: `keptHead` / `fullText` are only present when spilling. */
export interface SpillDecision {
  spill: boolean;
  /** Head slice (by code point) kept inline after spilling. */
  keptHead?: string;
  /** The full original text, captured BEFORE head slicing, for the spill file. */
  fullText?: string;
}

/** Inputs for {@link renderSpillReference}. */
export interface SpillReferenceInput {
  /** Workspace-relative path of the spill file the full text landed in. */
  relativePath: string;
  /** Total code points of the full text, used verbatim in the message. */
  totalChars: number;
}

/** Unicode code-point count (not UTF-16 code units) — same semantics as tool-result-prune. */
function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * Decide whether `text` must spill to disk. The threshold is compared in
 * Unicode code points (never UTF-16 units): at or below it the text passes
 * through with no head and no full text attached; above it the caller gets
 * both the inline head slice and the untouched full text.
 * Slicing by code point never splits a surrogate pair. Deterministic: no
 * locale, no clock, no randomness.
 */
export function decideSpill(text: string, opts: SpillDecisionOptions): SpillDecision {
  if (codePointLength(text) <= opts.thresholdChars) return { spill: false };
  return {
    spill: true,
    keptHead: [...text].slice(0, opts.headChars).join(""),
    fullText: text,
  };
}

/**
 * Render the model-facing reference appended after a spilled result. The
 * format string and both marker substrings (`output truncated:` /
 * `full output saved to`) are a cross-package contract — keep them verbatim.
 */
export function renderSpillReference(opts: SpillReferenceInput): string {
  return `\n\n[output truncated: ${opts.totalChars} chars total; full output saved to ${opts.relativePath} — read it with read_file if needed]`;
}
