import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineProject({
  resolve: {
    // Mirror the `@/*` -> `./*` path mapping from tsconfig.json so source
    // files under test can use the same alias Next.js resolves at build time.
    alias: {
      "@": dirname,
    },
  },
  test: {
    include: ["__tests__/**/*.test.ts"],
  },
});
