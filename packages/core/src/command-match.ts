/**
 * Strict argv matching for `commandPrefix` permission rules.
 *
 * A rule only ever fires on a command that is a SINGLE SIMPLE COMMAND with no
 * shell metacharacters. Anything else is disqualified and the call is asked
 * about as usual. This is the fail-closed direction on purpose: a prefix
 * allowlist whose match is wider than its label is exactly the illusion
 * SAFETY.md refuses to ship, and the textual match can never describe what a
 * compound command will actually do.
 *
 * Nothing here is I/O, and nothing here may become a permission BOUNDARY —
 * it only ever turns an "ask" into an "allow" (see evaluatePermission's
 * ceiling clamp). See docs/superpowers/specs/2026-09-20-shell-command-prefix-rules-design.md.
 */

/**
 * Any of these makes a command ineligible: they change what runs without
 * changing the leading text a rule matched, or introduce a second command.
 */
const DISQUALIFYING = new Set([
  ";", "&", "|", "<", ">", "`", "$", "(", ")", "{", "}", "*", "?", "[", "]", "~", "\\",
]);

/** A leading `NAME=value` changes the environment of what follows. */
const LEADING_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Split a command into argv tokens, or return `null` when it is not a single
 * simple command.
 *
 * Quotes are token delimiters only — no expansion, no escapes. A quote that
 * contains `$`, a backtick or a backslash is disqualified rather than
 * interpreted: interpreting it would make the matched text differ from what
 * the shell runs.
 */
export function tokenizeCommand(command: string): string[] | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  for (const ch of trimmed) {
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
        continue;
      }
      if (DISQUALIFYING.has(ch)) return null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\n" || ch === "\r") return null;
    if (DISQUALIFYING.has(ch)) return null;
    if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (quote !== undefined) return null; // unterminated
  if (current.length > 0) tokens.push(current);
  if (tokens.length === 0) return null;
  if (LEADING_ASSIGNMENT.test(tokens[0]!)) return null;
  return tokens;
}

/**
 * Whether `command` is a single simple command whose argv starts with
 * `prefix`, compared token by token (so `pnpm test2` does not match
 * `["pnpm","test"]`, but `pnpm test --filter x` does).
 */
export function matchesCommandPrefix(command: string, prefix: readonly string[]): boolean {
  if (prefix.length === 0) return false;
  const tokens = tokenizeCommand(command);
  if (tokens === null || tokens.length < prefix.length) return false;
  return prefix.every((token, index) => tokens[index] === token);
}

/**
 * Whether `token` is a usable `commandPrefix` token: non-empty, with no
 * whitespace, quotes, or character that disqualifies a command.
 *
 * Config loaders use this so a rule like `["pnpm", "test*"]` — which could
 * never match, because `*` disqualifies the command — fails loudly instead of
 * sitting in the config looking like it works. Whitespace is excluded by
 * policy even though a *quoted* argument can contain it: allowing it would
 * make a pattern's meaning depend on the quoting of the command it is
 * compared against, which is exactly the kind of hidden semantics this
 * feature must not have.
 */
export function isMatchableCommandToken(token: string): boolean {
  if (token.length === 0) return false;
  for (const ch of token) {
    if (DISQUALIFYING.has(ch)) return false;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") return false;
    if (ch === "'" || ch === '"') return false;
  }
  return true;
}
