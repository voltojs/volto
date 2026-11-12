import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('导出产物存在且不含 /gateway 前缀', () => {
  execFileSync('pnpm', ['--filter', '@volto/web', 'build'], {
    env: { ...process.env, VOLTO_WEB_EXPORT: '1' },
    stdio: 'inherit',
  });
  expect(existsSync('out/index.html')).toBe(true);
  expect(readFileSync('out/index.html', 'utf8')).not.toContain('/gateway');
});
