/**
 * Recognise high-signal shell commands so an approval prompt can say WHY a
 * command deserves a second look.
 *
 * SCOPE — read before extending. This is NOT a security boundary and must
 * never become one. `SAFETY.md` rules out classifying command content as a
 * gate, because a classifier stops the blatant case, misses the evasive one,
 * and leaves users believing they are covered. Nothing here may be consulted
 * by a permission decision: the output is display text, and a miss costs one
 * missing line of explanation, never a weakened boundary.
 *
 * Consequently: false negatives are fine, and the rule set is deliberately
 * small. Growing it toward "cover every dangerous command" is the failure
 * mode, not the goal.
 */

/** What a recognised command does that is worth reading twice. */
export type CommandRiskKind =
  | "irreversible-push"
  | "recursive-delete"
  | "remote-script-execution"
  | "public-publish"
  | "discards-uncommitted";

const RULES: ReadonlyArray<{ kind: CommandRiskKind; pattern: RegExp }> = [
  { kind: "irreversible-push", pattern: /\bgit\s+push\b/ },
  { kind: "recursive-delete", pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/ },
  { kind: "remote-script-execution", pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/ },
  { kind: "public-publish", pattern: /\b(npm|pnpm|yarn|cargo)\s+publish\b/ },
  // NOTE: the `clean` branch uses a trailing [a-z]* (not just a leading one)
  // so the required "-f" flag can appear anywhere in the flag cluster, e.g.
  // "-fd" as well as "-df" — a trailing \b right after a single leading
  // cluster would reject "-fd" since "f" would not be the last flag char.
  { kind: "discards-uncommitted", pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f[a-z]*)\b/ },
];

/**
 * Classify a shell command.
 *
 * @returns every kind the command matches, in rule order, without repeats.
 *   An empty array means "nothing recognised", which says nothing about
 *   whether the command is safe.
 */
export function classifyCommandRisk(command: string): CommandRiskKind[] {
  const kinds: CommandRiskKind[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(command) && !kinds.includes(rule.kind)) {
      kinds.push(rule.kind);
    }
  }
  return kinds;
}
