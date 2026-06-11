import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore } from "../index.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentState, SessionSnapshot } from "@agent-core/core";

const emptyState: AgentState = {
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
  maxWallclockMs: undefined,
  maxLoopCount: undefined,
  selfCorrectionCount: 0,
  maxSelfCorrections: undefined,
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tc-e4-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("TC-E4: FileStore atomic write 中断恢复", () => {
  it("corrupted file is skipped by list(); new save writes atomically via tmp → rename", async () => {
    const store = createStore({ directory: tempDir });

    // 1. Save a valid snapshot.
    const snapshot: SessionSnapshot = {
      id: "s1",
      state: emptyState,
      createdAt: 1000,
    };
    await store.save(snapshot);

    // Confirm the file is valid JSON.
    const loaded = await store.load("s1");
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe("s1");

    // 2. Manually corrupt the file (simulate a crash mid-write).
    const filePath = path.join(tempDir, "s1.json");
    await fs.writeFile(filePath, "{ truncated", "utf-8");

    // 3. list() must skip the corrupted file without throwing.
    const list = await store.list();
    expect(list).toHaveLength(0);

    // 4. Save a new snapshot — must succeed (atomic tmp → rename path).
    const snapshot2: SessionSnapshot = {
      id: "s2",
      state: emptyState,
      createdAt: 2000,
    };
    await store.save(snapshot2);

    const loaded2 = await store.load("s2");
    expect(loaded2).toBeDefined();
    expect(loaded2!.id).toBe("s2");
  });

  it("tmp file is not left behind after successful save", async () => {
    const store = createStore({ directory: tempDir });
    await store.save({
      id: "clean",
      state: emptyState,
      createdAt: 3000,
    });

    const files = await fs.readdir(tempDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
    expect(files).toContain("clean.json");
  });
});
