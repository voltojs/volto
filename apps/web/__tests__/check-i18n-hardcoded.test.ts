import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs script, no type declarations
import { checkI18nHardcoded } from '../../scripts/check-i18n-hardcoded.mjs';

let root = '';

function fixture(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'i18n-audit-'));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('checkI18nHardcoded', () => {
  it('reports a Chinese string literal in production code', () => {
    const dir = fixture({
      'components/Chat.tsx': 'export function Chat() {\n  return <div>你好</div>;\n}\n',
    });
    const hits = checkI18nHardcoded([dir]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 2 });
    expect((hits[0] as { text: string }).text).toContain('你好');
  });

  it('ignores comments, both whole-line and trailing', () => {
    const dir = fixture({
      'components/Chat.tsx': [
        '// 这是注释',
        '/* 块注释 中文 */',
        'const url = "https://example.com"; // 行尾注释',
        'export const ok = 1;',
        '',
      ].join('\n'),
    });
    expect(checkI18nHardcoded([dir])).toEqual([]);
  });

  it('ignores the message catalogs and test files', () => {
    const dir = fixture({
      'messages/zh/chat.json': '{ "a": "中文" }',
      'components/__tests__/x.test.tsx': 'const t = "中文";',
    });
    expect(checkI18nHardcoded([dir])).toEqual([]);
  });
});
