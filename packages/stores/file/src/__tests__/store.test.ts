import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore } from "../index.js";
import { runStoreContractTests } from "@agent-core/core/testing";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-test-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

runStoreContractTests(() => createStore({ directory: tempDir }));

describe("FileStore specifics", () => {
  it("creates directory if it does not exist", async () => {
    const newDir = path.join(tempDir, "nested", "dir");
    const store = createStore({ directory: newDir });
    await store.save({
      id: "test",
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
      },
      createdAt: Date.now(),
    });

    const loaded = await store.load("test");
    expect(loaded).toBeDefined();
  });

  it("handles corrupted JSON files gracefully in list", async () => {
    await fs.writeFile(path.join(tempDir, "bad.json"), "not json", "utf-8");
    await fs.writeFile(
      path.join(tempDir, "good.json"),
      JSON.stringify({
        id: "good",
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
        },
        createdAt: Date.now(),
      }),
      "utf-8",
    );

    const store = createStore({ directory: tempDir });
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("good");
  });

  it("throws on corrupted JSON in load (not silent)", async () => {
    // Write a valid file first so the ID sanitizer produces a known filename
    const store = createStore({ directory: tempDir });
    await store.save({
      id: "corrupt",
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
      },
      createdAt: Date.now(),
    });
    // Overwrite with invalid JSON
    await fs.writeFile(path.join(tempDir, "corrupt.json"), "not json", "utf-8");

    await expect(store.load("corrupt")).rejects.toThrow();
  });
});
