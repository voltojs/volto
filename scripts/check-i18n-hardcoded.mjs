#!/usr/bin/env node
/**
 * Fails the gate when user-facing Chinese copy is still hardcoded in source.
 *
 * Comments are stripped before scanning (the codebase keeps Chinese comments,
 * and they are not shipped copy), as are message catalogs, tests, and the
 * model-facing files whose prompts are deliberately English-only constants.
 *
 * Usage: node scripts/check-i18n-hardcoded.mjs [rootDir ...]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CJK = /[\u4e00-\u9fff]/;

/** Directories that hold translations or are not production code. */
const IGNORED_PATH_SEGMENTS = new Set([
  'node_modules',
  '.next',
  'dist',
  '__tests__',
  '.superpowers',
]);

/** Files whose content is the translation, not a hardcoded string. */
const IGNORED_FILE_PATTERNS = [
  /messages[\\/].*\.json$/,
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
];

const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Strips line and block comments while leaving string contents intact. */
export function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  let blockComment = false;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 2;
        continue;
      }
      if (ch === '\n') out += '\n';
      i += 1;
      continue;
    }
    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/') {
      // A regex literal can contain quotes and slashes; skipping it keeps the
      // string state machine in sync (e.g. /[\u4e00-\u9fff]/).
      const prev = out.trimEnd().slice(-1);
      if (prev === '' || '=(,:[!&|?{};'.includes(prev)) {
        i += 1;
        let inClass = false;
        while (i < source.length) {
          const c = source[i];
          if (c === '\\') {
            i += 2;
            continue;
          }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) {
            i += 1;
            break;
          } else if (c === '\n') break;
          i += 1;
        }
        out += ' ';
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    out += ch;
    i += 1;
  }
  return out;
}

/** Collects every non-ignored source file under `dir`. */
function collect(dir, files) {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_PATH_SEGMENTS.has(entry)) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      collect(path, files);
      continue;
    }
    if (!SOURCE_EXTENSIONS.test(entry)) continue;
    if (IGNORED_FILE_PATTERNS.some((pattern) => pattern.test(path))) continue;
    files.push(path);
  }
}

/**
 * Scans the given roots and returns `{ file, line, text }` for every line that
 * still carries CJK copy outside comments.
 */
export function checkI18nHardcoded(roots) {
  const files = [];
  for (const root of roots) {
    const stat = statSync(root);
    if (stat.isDirectory()) collect(root, files);
    else files.push(root);
  }
  const hits = [];
  for (const file of files) {
    if (IGNORED_FILE_PATTERNS.some((pattern) => pattern.test(file))) continue;
    const stripped = stripComments(readFileSync(file, 'utf8'));
    stripped.split('\n').forEach((line, index) => {
      if (!CJK.test(line)) return;
      hits.push({
        file: relative(process.cwd(), file).split(sep).join('/'),
        line: index + 1,
        text: line.trim().slice(0, 120),
      });
    });
  }
  return hits;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const roots = process.argv.slice(2);
  const targets = roots.length > 0 ? roots : ['apps/web', 'apps/headless-server/src', 'packages'];
  const hits = checkI18nHardcoded(targets);
  if (hits.length === 0) {
    console.log('i18n: no hardcoded CJK copy outside comments');
    process.exit(0);
  }
  for (const hit of hits) console.error(`${hit.file}:${hit.line}: ${hit.text}`);
  console.error(`\ni18n: ${hits.length} hardcoded line(s) — move the copy into a message catalog.`);
  process.exit(1);
}
