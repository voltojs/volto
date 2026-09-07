/**
 * User-explicit skill invocation: the `/name` gesture on a user message's
 * first line. Pure text processing — existence and invocability are checked
 * by the caller against the host's SkillRegistry, since core does no I/O.
 * See docs/superpowers/specs/2026-09-07-instruction-skill-completeness-design.md §5.4.
 */

/**
 * Kebab-case skill name grammar (matching dsh's). Requiring it here is what
 * keeps a path like "/usr/local/bin" from reading as an invocation: the `/`
 * after the first segment breaks the match.
 */
const INVOCATION = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s|$)/;

/** The invoked skill name, or null when the first line carries no gesture. */
export function parseSkillInvocation(text: string): string | null {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const match = INVOCATION.exec(firstLine);
  return match?.[1] ?? null;
}

/**
 * Deterministic rendering of an invoked skill's instructions. Mirrors the
 * skill tool's result header so both load paths read identically in context.
 */
export function renderSkillInjection(name: string, baseDir: string, body: string): string {
  return [
    `The user invoked the skill "${name}". Its full instructions follow.`,
    `Base directory: ${baseDir}`,
    "Resolve any relative path in the instructions below against that directory.",
    "",
    body,
  ].join("\n");
}
