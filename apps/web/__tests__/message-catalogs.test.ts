import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MESSAGES_DIR = join(process.cwd(), 'messages');

function flatten(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

function catalog(locale: string, namespace: string): string[] {
  const raw = readFileSync(join(MESSAGES_DIR, locale, `${namespace}.json`), 'utf8');
  return flatten(JSON.parse(raw)).sort();
}

const NAMESPACES = readdirSync(join(MESSAGES_DIR, 'zh'))
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.replace(/\.json$/, ''));

describe('web message catalogs', () => {
  it('ships at least one namespace', () => {
    expect(NAMESPACES.length).toBeGreaterThan(0);
  });

  it('keeps zh and en key sets identical for every namespace', () => {
    for (const namespace of NAMESPACES) {
      expect({ namespace, keys: catalog('en', namespace) }).toEqual({
        namespace,
        keys: catalog('zh', namespace),
      });
    }
  });
});
