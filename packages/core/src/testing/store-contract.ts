/**
 * Shared SessionStore contract tests.
 * Both memory and sqlite implementations must pass this suite.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { SessionStore, SessionSnapshot } from "../ports.js";
import type { AgentState } from "../state.js";

function makeSnapshot(id: string, overrides?: Partial<AgentState>): SessionSnapshot {
  return {
    id,
    state: {
      messages: [{ role: "user", content: "Hello" }],
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
      ...overrides,
    },
    createdAt: 1000000000000, // fixed timestamp for deterministic tests
  };
}

export function runStoreContractTests(createStore: () => SessionStore): void {
  let store: SessionStore;

  beforeEach(() => {
    store = createStore();
  });

  describe("SessionStore contract", () => {
    it("save and load round-trips correctly", async () => {
      const snapshot = makeSnapshot("s1");
      await store.save(snapshot);
      const loaded = await store.load("s1");

      expect(loaded).toBeDefined();
      expect(loaded!.id).toBe("s1");
      expect(loaded!.state.status).toBe("idle");
      expect(loaded!.state.messages).toHaveLength(1);
    });

    it("load returns undefined for unknown id", async () => {
      const loaded = await store.load("nonexistent");
      expect(loaded).toBeUndefined();
    });

    it("list returns all saved snapshots", async () => {
      await store.save(makeSnapshot("s1"));
      await store.save(makeSnapshot("s2"));
      await store.save(makeSnapshot("s3"));

      const all = await store.list();
      expect(all).toHaveLength(3);
      expect(all.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3"]);
    });

    it("overwrites existing snapshot with same id", async () => {
      const s1 = makeSnapshot("s1");
      await store.save(s1);

      const s2 = makeSnapshot("s1", { status: "done" });
      await store.save(s2);

      const loaded = await store.load("s1");
      expect(loaded!.state.status).toBe("done");
    });

    it("preserves AgentState structure through serialization", async () => {
      const snapshot = makeSnapshot("s1", {
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hi" },
          { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
        ],
        pendingTools: [{ id: "t1", name: "read_file", input: { path: "/a.ts" } }],
        pendingApprovalTool: { id: "t2", name: "edit_file", input: { path: "/b.ts" } },
        readFiles: [{ path: "/a.ts", version: 1, mtime: 1000 }],
        tokensUsed: 42,
        iterationCount: 3,
      });

      await store.save(snapshot);
      const loaded = await store.load("s1");

      expect(loaded!.state.messages).toHaveLength(3);
      expect(loaded!.state.pendingTools).toHaveLength(1);
      expect(loaded!.state.pendingApprovalTool?.id).toBe("t2");
      expect(loaded!.state.readFiles).toHaveLength(1);
      expect(loaded!.state.tokensUsed).toBe(42);
      expect(loaded!.state.iterationCount).toBe(3);
    });
  });
}
