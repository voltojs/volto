import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineProject({
  plugins: [react()],
  resolve: {
    // Mirror the `@/*` -> `./*` path mapping from tsconfig.json so source
    // files under test can use the same alias Next.js resolves at build time.
    alias: {
      '@': dirname,
    },
  },
  test: {
    // `.tsx` specs render components with @testing-library/react and need a
    // DOM, so only that subset gets the jsdom environment; plain `.ts` specs
    // stay on the faster default (node) environment. `**/` lets both the flat
    // legacy `__tests__/` dir and per-dir `lib/hooks/components/**/__tests__/`
    // subdirectories be discovered; without the leading `**/` the pattern is
    // root-anchored and nested specs are silently skipped.
    include: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
    environmentMatchGlobs: [['**/__tests__/**/*.test.tsx', 'jsdom']],
    setupFiles: ['./vitest.setup.ts'],
    // The budget exists to catch a hang, not to assert latency. The
    // whole-repo gate runs ~68 test tasks plus tsc and eslint concurrently on
    // far fewer cores, starving workers by more than 10x — provider-form tests
    // pass 609/609 in isolation yet blew the 5s default under a full
    // `turbo run typecheck lint test`. Mirrors the SDK's 30s budget
    // (packages/sdk/vitest.config.ts).
    testTimeout: 30_000,
  },
});
