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
    return new RegExp(needleLines.map(escapeRegExp).join("\\s*\\n\\s*"), "m");
  }

  // 2) Collapse inter-token whitespace.
  const collapsedHaystack = normalizeWhitespace(haystack);
  const collapsedNeedle = normalizeWhitespace(needle);
  if (collapsedHaystack.includes(collapsedNeedle)) {
    return new RegExp(collapsedNeedle.split(" ").map(escapeRegExp).join("\\s+"), "m");
  }

  return null;
}
