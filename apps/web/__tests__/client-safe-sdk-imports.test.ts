import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `@voltojs/sdk`'s root entry re-exports `createAgent`, `defaultSandbox`,
 * `AuditSink` and other values that reach into `@voltojs/runtime-node`, so a
 * value import of the root pulls `node:fs` into the browser bundle and breaks
 * the Next.js build. The client-safe subpaths (`@voltojs/sdk/sse`,
 * `/file-refs`, `/i18n`) are the supported surface for browser code; type-only
 * imports of the root are fine because TypeScript erases them.
 *
 * This guard turns that convention into a failing test instead of a bundler
 * error discovered at release time.
 */

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SDK_ROOT = '@voltojs/sdk';
const SCANNED_DIRS = ['app', 'components', 'hooks', 'lib', 'stores', 'i18n'];
const SKIPPED_DIRS = new Set(['node_modules', '.next', 'out', 'coverage', '__tests__', 'dist']);

const ROOT_IMPORT =
  /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)from\s*['"]@voltojs\/sdk['"]/g;

function isTypeOnlyBindings(clause: string): boolean {
  const trimmed = clause.trim();
  if (!trimmed) return false;
  // `import type ...` / `export type ...` is handled by the caller.
  if (!trimmed.startsWith('{')) return false;
  const inner = trimmed.replace(/^\{/, '').replace(/\}$/, '');
  const bindings = inner
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (bindings.length === 0) return false;
  return bindings.every((binding) => /^type\s+\w/.test(binding));
}

/** Returns one finding per value import of the SDK root entry. */
export function findUnsafeSdkRootImports(source: string): string[] {
  const findings: string[] = [];
  for (const match of source.matchAll(ROOT_IMPORT)) {
    const [, keyword, typeKeyword, clause] = match;
    if (typeKeyword) continue;
    if (isTypeOnlyBindings(clause ?? '')) continue;
    findings.push(`${keyword} ${(clause ?? '').trim()} from '${SDK_ROOT}'`);
  }
  return findings;
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}

describe('client-safe SDK imports', () => {
  it('allows type-only imports of the SDK root entry', () => {
    expect(findUnsafeSdkRootImports("import type { AgentSpec } from '@voltojs/sdk';")).toEqual([]);
    expect(findUnsafeSdkRootImports("import { type AgentSpec, type AgentEntry } from '@voltojs/sdk';")).toEqual([]);
    expect(findUnsafeSdkRootImports("export type { AgentSpec } from '@voltojs/sdk';")).toEqual([]);
  });

  it('allows the client-safe subpath entries', () => {
    expect(findUnsafeSdkRootImports("import { sse } from '@voltojs/sdk/sse';")).toEqual([]);
    expect(findUnsafeSdkRootImports("import { parentDir } from '@voltojs/sdk/file-refs';")).toEqual([]);
  });

  it('rejects value imports, including mixed type/value bindings', () => {
    expect(findUnsafeSdkRootImports("import { createAgent } from '@voltojs/sdk';")).toHaveLength(1);
    expect(findUnsafeSdkRootImports("import { type AgentSpec, createAgent } from '@voltojs/sdk';")).toHaveLength(1);
    expect(findUnsafeSdkRootImports("import sdk from '@voltojs/sdk';")).toHaveLength(1);
    expect(findUnsafeSdkRootImports("import * as sdk from '@voltojs/sdk';")).toHaveLength(1);
    expect(findUnsafeSdkRootImports("export { createAgent } from '@voltojs/sdk';")).toHaveLength(1);
  });

  it('keeps the web app free of value imports from the SDK root', () => {
    const offenders = SCANNED_DIRS.flatMap((dir) => {
      let files: string[];
      try {
        files = walk(join(WEB_ROOT, dir));
      } catch {
        return [];
      }
      return files.flatMap((file) => {
        const hits = findUnsafeSdkRootImports(readFileSync(file, 'utf8'));
        return hits.map((hit) => `${relative(WEB_ROOT, file)}: ${hit}`);
      });
    });

    expect(offenders).toEqual([]);
  });
});