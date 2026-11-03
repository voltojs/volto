/**
 * Pure recognition of project-file references in agent message text.
 *
 * Precision over recall: a false positive turns ordinary prose into a
 * dead link ("e.g." is not a file), while a false negative is just text.
 * Nothing here touches the DOM or stores — rendering layers decide what to
 * do with a parsed ref.
 */

export interface FileRef {
  /** Project-relative path, normalized (no leading `./` and no trailing `/`). */
  path: string;
  /**
   * `dir` only when the ref is statically known to be a directory (trailing
   * slash). Unknown refs omit it and resolve at click time.
   */
  kind?: 'file' | 'dir';
  /** 1-based start line, from `path:42`, `path#L42` and friends. */
  line?: number;
  /** 1-based inclusive end line of a range ref (`path:10-20`, `path#L42-L50`). */
  endLine?: number;
}

/** Absurd line numbers are date-stamps and junk, not line targets. */
const MAX_LINE = 100_000;

const WRAPPING_OPEN = new Set(['`', '"', "'", '(', '[', '{', '<', '「', '『', '“', '‘']);
const WRAPPING_CLOSE = new Set(['`', '"', "'", ')', ']', '}', '>', '」', '』', '”', '’']);
const TRAILING_PUNCT = new Set(['.', ',', ';', ':', '!', '?', '。', '，', '；', '：', '！', '？']);

const SEGMENT_RE = /^[\p{L}\p{N}_.@+-]+$/u;
const DOTFILE_RE = /^\.[\p{L}\p{N}_.@+-]+$/u;

function validLine(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_LINE;
}

/** Strip one matched wrapping pair (`...`, "...), (…)…) from both ends. */
function stripWrapping(s: string): string {
  let out = s;
  while (
    out.length >= 2 &&
    WRAPPING_OPEN.has(out[0] ?? '') &&
    WRAPPING_CLOSE.has(out[out.length - 1] ?? '')
  ) {
    out = out.slice(1, -1);
  }
  return out;
}

function stripTrailingPunct(s: string): string {
  let out = s;
  while (out.length > 0 && TRAILING_PUNCT.has(out[out.length - 1] ?? '')) {
    out = out.slice(0, -1);
  }
  return out;
}

interface PathCheck {
  ok: boolean;
  normalized: string;
  isDir: boolean;
}

function checkPath(raw: string, allowDots: boolean): PathCheck {
  if (raw === '' || /\s/.test(raw)) return { ok: false, normalized: raw, isDir: false };
  // A trailing slash marks a directory ref (`packages/tools/`); one slash
  // only — `a//` still leaves an empty segment and is rejected below.
  const isDir = raw.endsWith('/');
  let p = isDir ? raw.slice(0, -1) : raw;
  if (!allowDots) {
    while (p.startsWith('./')) p = p.slice(2);
  }
  if (p === '' || p.startsWith('/') || p.startsWith('~') || p.startsWith('www.')) {
    return { ok: false, normalized: p, isDir };
  }
  if (p.includes('\\') || p.includes(':') || p.includes('#') || p.includes('://')) {
    return { ok: false, normalized: p, isDir };
  }
  const segments = p.split('/');
  for (const seg of segments) {
    if (seg === '') return { ok: false, normalized: p, isDir };
    // `.` / `..` segments are only meaningful in link refs, where
    // resolveFileRef normalizes them against a base directory.
    if (seg === '.' || seg === '..') {
      if (allowDots) continue;
      return { ok: false, normalized: p, isDir };
    }
    // `@`-leading segments name npm scopes or import aliases (@volto/core,
    // @/lib/utils) — package references, not project files. Clicking them
    // can only land on a broken preview, so they stay plain text.
    if (seg.startsWith('@') || !SEGMENT_RE.test(seg)) {
      return { ok: false, normalized: p, isDir };
    }
  }
  // A bare word without a slash is only file-like with a real extension or as
  // a dotfile — this is what keeps "e.g." / "i.e." / "Yes" out. Link hrefs are
  // intentional and skip this check (LICENSE, Makefile… are valid targets).
  if (!allowDots && !isDir && !p.includes('/')) {
    const last = segments[segments.length - 1] ?? '';
    const dot = last.lastIndexOf('.');
    const fileLike = DOTFILE_RE.test(last) || (dot > 0 && last.length - dot - 1 >= 2);
    if (!fileLike) return { ok: false, normalized: p, isDir };
  }
  return { ok: true, normalized: p, isDir };
}

/**
 * Parse one message fragment as a file reference.
 *
 * Accepts `path`, `path:42`, `path:42:7`, `path:10-20`, `path#L42`,
 * `path#L42-L50`, optionally wrapped in quotes/brackets and followed by
 * sentence punctuation. Returns null for anything that is not a plausible
 * project-relative file. Strict form: rejects `.`/`..` segments and bare
 * words without a real extension.
 */
export function parseFileRef(text: string): FileRef | null {
  return parseRefInternal(text, false);
}

/**
 * Parse a markdown link href as a file reference. Lenient where intentional
 * links allow it: `./` / `../` segments survive (resolveFileRef normalizes
 * them) and an extensionless target counts. URLs, anchors and anything with
 * whitespace still return null.
 */
export function parseLinkRef(text: string): FileRef | null {
  return parseRefInternal(text, true);
}

function parseRefInternal(text: string, allowDots: boolean): FileRef | null {
  if (typeof text !== 'string') return null;
  const cleaned = stripTrailingPunct(stripWrapping(text.trim()));
  if (cleaned === '') return null;

  let path = cleaned;
  let line: number | undefined;
  let endLine: number | undefined;

  // Each suffix form parses its own groups: the third group of `path:line:col`
  // is a column and must not become an endLine.
  const anchor = /^(.*)#L(\d+)(?:-L?(\d+))?$/.exec(cleaned);
  const lineCol = /^(.*):(\d+):(\d+)$/.exec(cleaned);
  const range = /^(.*):(\d+)-(\d+)$/.exec(cleaned);
  const single = /^(.*):(\d+)$/.exec(cleaned);

  const suffixMatch = anchor ?? lineCol ?? range ?? single;
  if (suffixMatch !== null) {
    path = suffixMatch[1] ?? '';
    if (anchor !== null) {
      line = Number(anchor[2]);
      if (anchor[3] !== undefined) endLine = Number(anchor[3]);
    } else if (lineCol !== null) {
      line = Number(lineCol[2]);
    } else if (range !== null) {
      line = Number(range[2]);
      endLine = Number(range[3]);
    } else if (single !== null) {
      line = Number(single[2]);
    }
    const ok =
      line !== undefined &&
      validLine(line) &&
      (endLine === undefined || (validLine(endLine) && endLine >= line));
    if (!ok) return null;
  }

  const check = checkPath(path, allowDots);
  if (!check.ok) return null;
  const ref: FileRef = { path: check.normalized };
  if (check.isDir) ref.kind = 'dir';
  if (line !== undefined) ref.line = line;
  if (endLine !== undefined) ref.endLine = endLine;
  return ref;
}

const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);

/**
 * The file a tool call references, if the call is about one project file.
 * `glob`/`grep` patterns and scopes are not "a mentioned file" and return null.
 */
export function toolCallFileRef(
  name: string,
  args: Record<string, unknown>,
): FileRef | null {
  if (!FILE_TOOLS.has(name)) return null;
  const raw = args['path'] ?? args['file_path'];
  if (typeof raw !== 'string') return null;
  return parseFileRef(raw);
}

/**
 * Resolve a parsed ref against a project-relative base directory (the
 * directory of the containing file for previewed markdown; `''` at the chat
 * surface). Normalizes `.`/`..` segments and returns null when the target
 * escapes the project root.
 */
export function resolveFileRef(baseDir: string, ref: FileRef): FileRef | null {
  const base = baseDir === '' ? [] : baseDir.split('/');
  const stack: string[] = [];
  for (const part of [...base, ...ref.path.split('/')]) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  if (stack.length === 0) return null;
  return { ...ref, path: stack.join('/') };
}

/** Project-relative parent directory of a path; '' at the root. */
export function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}
