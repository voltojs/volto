/**
 * User-explicit skill invocation: the `/name` gesture on a user message's
 * first line. Pure text processing — existence and invocability are checked
 * by the caller against the host's SkillRegistry, since core does no I/O.
 * See docs/superpowers/specs/2026-09-07-instruction-skill-completeness-design.md §5.4.
 */

import { truncateUtf8 } from "./workspace-instructions.js";

/**
 * Byte cap on a rendered `/name` skill injection. Mirrors MAX_SKILL_BODY_BYTES
 * in packages/tools/skill/src/index.ts (the `skill` tool's own cap on
 * modelContent) — both paths put a skill's full, unbounded, user-authored body
 * into the conversation, so both must be bounded by the same limit. Without
 * this, a multi-megabyte SKILL.md invoked via `/name` lands in `messages`
 * uncapped: not just a full context window, but a request the provider
 * rejects outright, resent on every subsequent turn since it lives in
 * `messages` rather than a per-turn system layer. Kept as a separate literal
 * (not shared via import) because packages/tools/skill may only `import type`
 * from @volto/core, never a value.
 */
const MAX_SKILL_INJECTION_BYTES = 64 * 1024;

/**
 * Caps a rendered skill injection (as produced by renderSkillInjection) at
 * maxBytes UTF-8 bytes and appends a visible truncation notice — same
 * truncate-then-notice convention as the `skill` tool's capSkillResult.
 * Reuses truncateUtf8's byte-safe cut (never splits a multi-byte code point
 * at the boundary) rather than re-implementing it, so this is the only place
 * in the `/name` path that touches raw bytes.
 */
export function capSkillInjection(
  text: string,
  maxBytes: number = MAX_SKILL_INJECTION_BYTES,
): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return text;
  const notice =
    `\n\n[skill body truncated from ${encoded.length} to ${maxBytes} bytes` +
    " — read the files under the base directory if you need the remainder]";
  const noticeBytes = new TextEncoder().encode(notice).length;
  const room = Math.max(0, maxBytes - noticeBytes);
  return truncateUtf8(text, room) + notice;
}

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
 * Deterministic rendering of an invoked skill's instructions. Shares the base
 * directory and resolution instructions with renderSkillResult from packages/tools/skill,
 * but uses a different first line ("The user invoked...") to signal that this is a
 * user-explicit /name gesture.
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
