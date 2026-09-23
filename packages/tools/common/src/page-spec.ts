/**
 * Page-spec parsing for paginated document reads (Claude Code Read's
 * `pages` vocabulary): "2", "1,3,5", "2-4", "5, 1-3, 7".
 *
 * Fail-closed: anything that is not a well-formed list of positive
 * integers / inclusive ranges returns null so the caller answers with a
 * usage error — silently guessing a page set would hide a typo (reading
 * page 3 when the model meant page 8) behind a plausible-looking answer.
 */

const PAGE_TOKEN = /^(\d+)(?:-(\d+))?$/;

export function parsePageSpec(spec: string): number[] | null {
  const out: number[] = [];
  for (const raw of spec.split(",")) {
    const token = raw.trim();
    if (token === "") return null;
    const m = PAGE_TOKEN.exec(token);
    if (!m) return null;
    const from = Number.parseInt(m[1]!, 10);
    if (from < 1) return null;
    if (m[2] === undefined) {
      out.push(from);
      continue;
    }
    const to = Number.parseInt(m[2], 10);
    if (to < from) return null;
    for (let p = from; p <= to; p++) out.push(p);
  }
  return out.length > 0 ? out : null;
}
