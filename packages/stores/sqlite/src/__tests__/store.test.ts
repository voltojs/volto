import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore } from "../index.js";
import { runStoreContractTests } from "@voltojs/core/testing";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

let tempDir: string;
let dbPath: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-sqlite-test-"));
  dbPath = path.join(tempDir, "test.db");
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

runStoreContractTests(() => createStore({ path: dbPath }));

describe("SQLiteStore specifics", () => {
  it("persists data across store instances (same file)", async () => {
    const store1 = createStore({ path: dbPath });
    await store1.save({
      id: "cross-instance",
      state: {
        messages: [],
        pendingTools: [],
        status: "idle",
        tokenBudget: undefined,
        tokensUsed: 0,
        maxIterations: 20,
        iterationCount: 0,
        readFiles: [],
        queuedUserInputs: [],
        toolCallCount: 0,
        maxToolCalls: undefined,
        maxCostDollars: undefined,
      maxTokensPerTurn: undefined,
        maxWallclockMs: undefined,
        maxLoopCount: undefined,
        selfCorrectionCount: 0,
        maxSelfCorrections: undefined,
        loopInterventionCount: 0,
        loopRemindedCount: 0,
      },
      createdAt: 1000,
    });

    // Create a new store instance pointing to the same file
    const store2 = createStore({ path: dbPath });
    const loaded = await store2.load("cross-instance");
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe("cross-instance");
    expect(loaded!.createdAt).toBe(1000);
  });

  it("creates database file if it does not exist", async () => {
    const nestedPath = path.join(tempDir, "nested", "dir", "test.db");
    const store = createStore({ path: nestedPath });
    await store.save({
      id: "auto-create",
      state: {
        messages: [],
        pendingTools: [],
        status: "idle",
        tokenBudget: undefined,
        tokensUsed: 0,
        maxIterations: 20,
        iterationCount: 0,
        readFiles: [],
        queuedUserInputs: [],
        toolCallCount: 0,
        maxToolCalls: undefined,
        maxCostDollars: undefined,
      maxTokensPerTurn: undefined,
        maxWallclockMs: undefined,
        maxLoopCount: undefined,
        selfCorrectionCount: 0,
        maxSelfCorrections: undefined,
        loopInterventionCount: 0,
        loopRemindedCount: 0,
      },
      createdAt: 2000,
    });

    const loaded = await store.load("auto-create");
    expect(loaded).toBeDefined();
  });
});
