/**
 * Pure recognition of project-file references in agent message text.
 *
 * Precision over recall: a false positive turns ordinary prose into a dead
 * link ("e.g." is not a file), while a false negative is just text. Only
 * files are judged — directories, branch names, commit ranges and property
 * accesses stay plain text. Nothing here touches the DOM or stores —
 * rendering layers decide what to do with a parsed ref.
 */

export interface FileRef {
  /** Project-relative path, normalized (no leading `./`). */
  path: string;
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

/**
 * Prose-surface extension whitelist. A bare word counts as a file mention
 * only with one of these extensions (or as a dotfile): "extension length >= 2"
 * admits property accesses (`record.events`), extensionless paths look like
 * branch names, and git ranges (`main...a1b2`) fall to the consecutive-dot
 * rule. An explicit list trades recall for the precision this surface needs.
 */
const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'json', 'jsonc', 'md', 'mdx', 'markdown', 'txt', 'text', 'log',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'example', 'lock',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'svg', 'vue', 'svelte', 'astro',
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'lua', 'r', 'dart',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'graphql', 'gql',
  'csv', 'tsv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'pdf',
  'tf', 'hcl', 'proto', 'gradle', 'cmake', 'mk',
]);

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
}

interface ParseOptions {
  /** Allow `.` / `..` segments (link hrefs resolve them against a base). */
  allowDots: boolean;
  /** Require the file-shape gate: dotfile or whitelisted extension. */
  fileShaped: boolean;
}

function checkPath(raw: string, opts: ParseOptions): PathCheck {
  if (raw === '' || /\s/.test(raw)) return { ok: false, normalized: raw };
  let p = raw;
  if (!opts.allowDots) {
    while (p.startsWith('./')) p = p.slice(2);
  }
  if (p === '' || p.startsWith('/') || p.startsWith('~') || p.startsWith('www.')) {
    return { ok: false, normalized: p };
  }
  if (p.includes('\\') || p.includes(':') || p.includes('#') || p.includes('://')) {
    return { ok: false, normalized: p };
  }
  const segments = p.split('/');
  for (const seg of segments) {
    if (seg === '') return { ok: false, normalized: p };
    // `.` / `..` segments are only meaningful in link refs, where
    // resolveFileRef normalizes them against a base directory.
    if (seg === '.' || seg === '..') {
      if (opts.allowDots) continue;
      return { ok: false, normalized: p };
    }
    // Consecutive dots inside a segment are git ranges (`main...a1b2`,
    // `dev..main`), not file names.
    if (seg.includes('..') || seg.startsWith('@') || !SEGMENT_RE.test(seg)) {
      return { ok: false, normalized: p };
    }
  }
  if (opts.fileShaped) {
    // File-shape gate: dotfiles and whitelisted extensions only.
    // Extensionless paths (`analysis/agent-info-flow`) are more often
    // branch names than files and stay plain text.
    const last = segments[segments.length - 1] ?? '';
    const dot = last.lastIndexOf('.');
    const ext = dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
    if (!DOTFILE_RE.test(last) && !KNOWN_EXTENSIONS.has(ext)) {
      return { ok: false, normalized: p };
    }
  }
  return { ok: true, normalized: p };
}

function parseRefInternal(text: string, opts: ParseOptions): FileRef | null {
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

  const check = checkPath(path, opts);
  if (!check.ok) return null;
  const ref: FileRef = { path: check.normalized };
  if (line !== undefined) ref.line = line;
  if (endLine !== undefined) ref.endLine = endLine;
  return ref;
}

/**
 * Parse one message fragment as a file reference (strict prose form).
 *
 * Accepts `path`, `path:42`, `path:42:7`, `path:10-20`, `path#L42`,
 * `path#L42-L50`, optionally wrapped in quotes/brackets and followed by
 * sentence punctuation. Returns null for anything that is not a plausible
 * project-relative file: dotfiles and whitelisted extensions only.
 */
export function parseFileRef(text: string): FileRef | null {
  return parseRefInternal(text, { allowDots: false, fileShaped: true });
}

/**
 * Parse a markdown link href as a file reference. Lenient where intentional
 * links allow it: `./` / `../` segments survive (resolveFileRef normalizes
 * them against a base directory). The file-shape gate still applies — a link
 * to a non-file renders inert instead of navigating. URLs and anchors return
 * null and stay regular links.
 */
export function parseLinkRef(text: string): FileRef | null {
  return parseRefInternal(text, { allowDots: true, fileShaped: true });
}

/**
 * Parse a structured tool-call path argument. Lenient on purpose: the arg
 * names a file the model actually operated on, so unusual extensions
 * (`Makefile`, `record.events`) are real files here, unlike in prose.
 */
function parseToolRef(text: string): FileRef | null {
  return parseRefInternal(text, { allowDots: false, fileShaped: false });
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
  return parseToolRef(raw);
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
