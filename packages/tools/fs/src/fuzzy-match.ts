function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function computeFuzzyMatchRegex(haystack: string, needle: string): RegExp | null {
  const lineSplit = (value: string) => value.split(/\r?\n/);

  // 1) Ignore leading/trailing whitespace per line.
  const haystackLines = lineSplit(haystack).map((line) => line.trim());
  const needleLines = lineSplit(needle).map((line) => line.trim());
  const joinedHaystack = haystackLines.join("\n");
  const joinedNeedle = needleLines.join("\n");
  if (joinedHaystack.includes(joinedNeedle)) {
    return new RegExp(needleLines.map(escapeRegExp).join("\\s*\\n\\s*"), "gm");
  }

  // 2) Collapse inter-token whitespace.
  const collapsedHaystack = normalizeWhitespace(haystack);
  const collapsedNeedle = normalizeWhitespace(needle);
  if (collapsedHaystack.includes(collapsedNeedle)) {
    return new RegExp(collapsedNeedle.split(" ").map(escapeRegExp).join("\\s+"), "gm");
  }

  return null;
}

/**
 * Find a fuzzy match that starts at a valid position:
 * - Start of string, or
 * - After a newline (line start), or
 * - After only whitespace on the same line (handles leading indentation).
 *
 * This prevents false matches like "xxfoo\nbar" matching "foo\nbar".
 */
export function findFuzzyMatch(content: string, regex: RegExp): RegExpExecArray | null {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match.index === 0) return match;
    const prevChar = content[match.index - 1];
    if (prevChar === "\n") return match;
    // Check if all characters from the last newline to match.index are whitespace.
    const lastNewline = content.lastIndexOf("\n", match.index - 1);
    const linePrefix = content.slice(lastNewline + 1, match.index);
    if (linePrefix.trim() === "") return match;
  }
  return null;
}

/**
 * Preserve the indentation of the matched region when applying a fuzzy replacement.
 * Detects the leading whitespace of each line in the matched region and prepends
 * it to the corresponding line in the new string.
 */
export function preserveIndentation(content: string, matchIndex: number, newString: string): string {
  const lineStart = content.lastIndexOf("\n", matchIndex) + 1;
  const firstLineIndent = content.slice(lineStart, matchIndex);

  return newString.split("\n").map((line, i) => {
    if (i === 0) return line;
    return firstLineIndent + line;
  }).join("\n");
}
