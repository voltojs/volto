import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globals: false,
    // This package's tests drive real subprocesses: shells, sandboxed
    // `sandbox-exec`/`bwrap` children, git, long-lived bash sessions. Under
    // vitest's 5s default a test is killed before its own wait budget is
    // reached (`waitUntil(..., 15000)` was unreachable dead code), so
    // whole-repo runs where typecheck/lint/test compete for CPU fail on
    // timing rather than on behaviour. Waits inside tests stay bounded and
    // condition-based; this only stops the harness from cutting them short.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Serialize test FILES as well. Several suites here assert on the shared
    // os.tmpdir() — sandbox-session.test.ts counts `volto-sandbox-*.sb` files
    // to prove a killed session unlinks its seatbelt profile, and any other
    // file that starts a confined process writes one into the same directory.
    // Run in parallel, those assertions observe each other's profiles and fail
    // on timing rather than on behaviour.
    fileParallelism: false,
  },
});
