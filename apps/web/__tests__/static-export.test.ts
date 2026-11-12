import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// This case drives a real `next build`, which is 4s on an idle machine and
// takes as long as the machine gives it under the whole-repo gate (every
// package's tests plus tsc and eslint competing for the same cores). The 30s
// suite budget is there to catch a hang; a build that is merely queued is not
// a failure, so this case gets a budget of its own instead of the assertion
// being loosened.
it('导出产物存在且不含 /gateway 前缀', { timeout: 180_000 }, () => {
  // A scrubbed child env: `stdio: 'inherit'` also inherits the environment,
  // so anything this build sets would flow back into the parent — and with
  // file parallelism on, into every other spec running in this process.
  // `next build` in particular must not leak a rewrite target into a suite
  // that is asserting on what the app resolves at runtime.
  // `ProcessEnv` is not a plain string map here (Next narrows `NODE_ENV` to a
  // readonly union), so build the copy explicitly instead of deleting a key.
  const env: NodeJS.ProcessEnv = { ...process.env, VOLTO_WEB_EXPORT: '1' };
  delete env['NEXT_PUBLIC_AGENT_SERVER_URL'];
  execFileSync('pnpm', ['--filter', '@volto/web', 'build'], {
    env,
    stdio: 'inherit',
  });
  expect(existsSync('out/index.html')).toBe(true);
  expect(readFileSync('out/index.html', 'utf8')).not.toContain('/gateway');
});
