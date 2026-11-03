/**
 * Split a highlight.js HTML string into per-line HTML snippets.
 *
 * hljs spans can cross line breaks (block comments, template strings), so a
 * naive `html.split('\n')` produces broken markup. This tokenizer closes every
 * open span at a line break and reopens the same stack on the next line, which
 * keeps every line independently renderable and visually identical to the
 * unsplit highlight.
 */

const TOKEN_RE = /<span\b[^>]*>|<\/span>|[^<]+|</g;

export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const openStack: string[] = [];
  let current = '';

  for (const token of html.matchAll(TOKEN_RE)) {
    const t = token[0];
    if (t.startsWith('<span')) {
      openStack.push(t);
      current += t;
    } else if (t === '</span>') {
      openStack.pop();
      current += t;
    } else if (t === '<') {
      current += t;
    } else {
      const parts = t.split('\n');
      current += parts[0] ?? '';
      for (let i = 1; i < parts.length; i += 1) {
        lines.push(current + '</span>'.repeat(openStack.length));
        current = openStack.join('') + (parts[i] ?? '');
      }
    }
  }
  lines.push(current);
  return lines;
}
