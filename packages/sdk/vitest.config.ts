import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    include: [
      "src/__tests__/**/*.test.ts",
      "src/sse/__tests__/**/*.test.ts",
      "src/agent-registry/__tests__/**/*.test.ts",
    ],
    // These budgets exist to catch a hang, not to assert latency. The
    // whole-repo gate runs ~68 test tasks plus tsc and eslint concurrently on
    // far fewer cores, so a worker can be starved by more than 10x: the
    // debugger checkpoint test measures 307ms in isolation and still blew the
    // 5s default under a full `turbo run typecheck lint test`. Sizing these
    // for an idle machine turns CPU contention into red builds.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
