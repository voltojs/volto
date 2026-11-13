/**
 * score.ts — pure lexical scoring for memory retrieval.
 *
 * Zero dependencies, no I/O: every function here is a pure string
 * transformation so both `@voltojs/memory-file` and `@voltojs/memory-inmemory`
 * share one ranking implementation (spec §4.3, decision D4).
 */

/** Default per-scope live-entry cap (spec §4.3 / §7). */
export const DEFAULT_MEMORY_MAX_ENTRIES = 5000;

/**
 * Normalize text for matching: NFKC (folds full-width / ligature forms),
 * lowercase, collapse whitespace runs (incl. NBSP) to single spaces, trim.
 */
export function normalizeMemoryText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tokenize a normalized-or-raw query:
 * - ASCII/latin runs matching `[a-z0-9_]+` become one token each;
 * - CJK runs become 2-char sliding windows (a lone char stays a single token).
 */
export function tokenizeMemoryQuery(text: string): string[] {
  const normalized = normalizeMemoryText(text);
  const tokens: string[] = [];
  // Match runs of word-ish ASCII plus CJK-ish scripts, then split by kind.
  // The CJK class covers unified ideographs (incl. extension A and compat
  // forms), kana, hangul syllables, and astral-plane ideographs (𠮷 etc.);
  // runs of any of them become 2-char sliding windows below.
  const runPattern =
    /[a-z0-9_]+|[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯\u{20000}-\u{2ffff}]+/gu;
  for (const match of normalized.matchAll(runPattern)) {
    const run = match[0];
    // The ASCII class always matches a whole run, so no second test.
    if (/^[a-z0-9_]+$/.test(run)) {
      tokens.push(run);
      continue;
    }
    const chars = Array.from(run);
    if (chars.length === 1) {
      tokens.push(chars[0] as string);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i += 1) {
      tokens.push(`${chars[i]}${chars[i + 1]}`);
    }
  }
  return tokens;
}

/** Per-token counted-occurrence cap (spec §4.3 rule 3). */
const TOKEN_HIT_CAP = 3;
/** Bonus applied when the normalized query is an exact substring of the text. */
const SUBSTRING_BONUS = 5;

/**
 * Score `text` against `query`.
 *
 * Total = sum over query tokens of `min(count, 3)` occurrences in the
 * normalized text, plus +5 when the whole normalized query appears as a
 * contiguous substring. Returns 0 when nothing matched or the query is empty.
 */
export function scoreMemoryText(query: string, text: string): number {
  const normalizedQuery = normalizeMemoryText(query);
  if (normalizedQuery === "") return 0;
  const normalizedText = normalizeMemoryText(text);
  if (normalizedText === "") return 0;

  let score = 0;
  for (const token of tokenizeMemoryQuery(normalizedQuery)) {
    let count = 0;
    let from = 0;
    while (count < TOKEN_HIT_CAP) {
      const at = normalizedText.indexOf(token, from);
      if (at === -1) break;
      count += 1;
      from = at + token.length;
    }
    score += count;
  }

  if (score > 0 && normalizedText.includes(normalizedQuery)) {
    score += SUBSTRING_BONUS;
  }
  return score;
}
