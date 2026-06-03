import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { defineConfig } from "vitest/config";

// The integration test reads OPENAI_* from process.env. `vitest run` does not
// load .env on its own, so we load the monorepo-root .env via dotenv and inject
// the parsed vars into the test environment. When no .env exists (e.g. CI),
// `parsed` is undefined → {} → the integration test skips via describe.skipIf.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const parsed = loadDotenv({ path: resolve(repoRoot, ".env"), quiet: true }).parsed ?? {};
// Drop empty values so a blank `OPENAI_BASE_URL=` doesn't override real defaults.
const env = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== ""));

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globals: false,
    env,
  },
});
