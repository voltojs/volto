import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import * as path from "node:path";

describe("TC-E13: Core barrel 无 vitest 污染", () => {
  it("importing @volto/core in non-test env does not trigger vitest loading", () => {
    // Run a plain Node script (no vitest) that imports the core barrel.
    // If vitest leaks into the barrel, this will fail with a module-not-found
    // or vitest-related error.
    const coreDist = path.resolve(__dirname, "../../dist/index.js");
    const script = `
      import("${coreDist}")
        .then((mod) => {
          // Verify core exports are present.
          if (typeof mod.step !== "function") {
            process.exit(1);
          }
          if (typeof mod.createInitialState !== "function") {
            process.exit(1);
          }
          // Verify runStoreContractTests is NOT in the barrel.
          if (mod.runStoreContractTests !== undefined) {
            process.exit(2);
          }
          process.exit(0);
        })
        .catch((err) => {
          console.error(err);
          process.exit(3);
        });
    `;

    try {
      // Exit code 0 means success; execSync throws on any non-zero exit.
      execSync(`node --input-type=module -e '${script.replace(/'/g, "\\'")}'`, {
        encoding: "utf-8",
        timeout: 10_000,
      });
    } catch (err: unknown) {
      const error = err as { status?: number; stderr?: string };
      // Exit code 2 means runStoreContractTests was found in barrel (fail).
      if (error.status === 2) {
        expect.fail("runStoreContractTests should NOT be exported from the core barrel");
      }
      // Other non-zero exit codes indicate vitest pollution or import failure.
      expect.fail(
        `Core barrel import failed in non-test env (exit ${error.status}): ${error.stderr}`,
      );
    }
  });

  it("runStoreContractTests is available from @volto/core/testing", async () => {
    // Verify the testing submodule is importable separately.
    const testingMod = await import("../testing/store-contract.js");
    expect(testingMod.runStoreContractTests).toBeDefined();
    expect(typeof testingMod.runStoreContractTests).toBe("function");
  });
});
