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
    // stay on the faster default (node) environment.
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
    environmentMatchGlobs: [['__tests__/**/*.test.tsx', 'jsdom']],
    setupFiles: ['./vitest.setup.ts'],
  },
});
