import { describe, it, expect } from "vitest";
import { createInMemoryMemoryStore } from "../memory.js";
import type { MemoryEntry } from "@volto/core";

function entry(text: string, overrides?: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "",
    text,
    metadata: {},
    ...overrides,
  };
}

describe("createInMemoryMemoryStore", () => {
  describe("save and query", () => {
    it("should save and retrieve entries", async () => {
      const store = createInMemoryMemoryStore();
      const id = await store.save(entry("Hello world"));
      expect(id).toBeTruthy();

      const results = await store.query("Hello", 10);
      expect(results).toHaveLength(1);
      expect(results[0]?.text).toBe("Hello world");
    });

    it("should respect k limit", async () => {
      const store = createInMemoryMemoryStore();
      await store.save(entry("alpha one"));
      await store.save(entry("alpha two"));
      await store.save(entry("alpha three"));

      const results = await store.query("alpha", 2);
      expect(results).toHaveLength(2);
    });

    it("should delete entries", async () => {
      const store = createInMemoryMemoryStore();
      const id = await store.save(entry("Delete me"));
      expect(await store.delete(id)).toBe(true);
      expect(await store.delete(id)).toBe(false);
      expect(await store.query("Delete", 10)).toHaveLength(0);
    });

    it("generates a non-empty id for id: ''", async () => {
      const store = createInMemoryMemoryStore();
      const id = await store.save(entry("generated id fact"));
      expect(id).not.toBe("");
      expect(id.length).toBeGreaterThan(0);

      const results = await store.query("generated id fact", 10);
      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe(id);
    });

    it("returns [] for a non-matching query", async () => {
      const store = createInMemoryMemoryStore();
      await store.save(entry("alpha fact"));
      await store.save(entry("beta fact"));

      expect(await store.query("gamma", 10)).toEqual([]);
    });

    it("ranks lexical matches by score, not insertion order", async () => {
      const store = createInMemoryMemoryStore();
      await store.save(entry("alpha beta"));
      await store.save(entry("alpha beta gamma delta"));

      const results = await store.query("alpha beta gamma", 10);
      expect(results.map((e) => e.text)).toEqual([
        "alpha beta gamma delta",
        "alpha beta",
      ]);
    });
  });

  describe("query filter (spec §4.1)", () => {
    it("returns only p1 entries plus global for { projectId: 'p1' }", async () => {
      const store = createInMemoryMemoryStore();
      await store.save(
        entry("episodic one", { scope: { kind: "project", projectId: "p1" } }),
      );
      await store.save(
        entry("episodic two", { scope: { kind: "project", projectId: "p2" } }),
      );
      await store.save(entry("episodic global", { scope: { kind: "global" } }));

      const results = await store.query("episodic", 10, { projectId: "p1" });
      expect(results.map((e) => e.text).sort()).toEqual([
        "episodic global",
        "episodic one",
      ]);
    });

    it("excludes global entries with { projectId, includeGlobal: false }", async () => {
      const store = createInMemoryMemoryStore();
      await store.save(
        entry("alpha one", { scope: { kind: "project", projectId: "p1" } }),
      );
      await store.save(entry("alpha global", { scope: { kind: "global" } }));

      const results = await store.query("alpha", 10, {
        projectId: "p1",
        includeGlobal: false,
      });
      expect(results.map((e) => e.text)).toEqual(["alpha one"]);
    });

    it("excludes global entries for { includeGlobal: false } without projectId", async () => {
      const store = createInMemoryMemoryStore();
      await store.save(
        entry("alpha one", { scope: { kind: "project", projectId: "p1" } }),
      );
      await store.save(entry("alpha global", { scope: { kind: "global" } }));

      const results = await store.query("alpha", 10, { includeGlobal: false });
      expect(results).toEqual([]);
    });

    it("returns [] for an empty filter object while no filter returns all", async () => {
      const store = createInMemoryMemoryStore();
      await store.save(
        entry("alpha one", { scope: { kind: "project", projectId: "p1" } }),
      );
      await store.save(entry("alpha global", { scope: { kind: "global" } }));

      expect(await store.query("alpha", 10, {})).toEqual([]);
      expect(await store.query("alpha", 10)).toHaveLength(2);
    });

    it("returns global only for { includeGlobal: true } without projectId", async () => {
      const store = createInMemoryMemoryStore();
      await store.save(
        entry("alpha one", { scope: { kind: "project", projectId: "p1" } }),
      );
      await store.save(entry("alpha global", { scope: { kind: "global" } }));

      const results = await store.query("alpha", 10, { includeGlobal: true });
      expect(results.map((e) => e.text)).toEqual(["alpha global"]);
    });

    it("treats a missing scope as global", async () => {
      const store = createInMemoryMemoryStore();
      await store.save(entry("alpha legacy entry"));

      const results = await store.query("alpha", 10, { includeGlobal: true });
      expect(results.map((e) => e.text)).toEqual(["alpha legacy entry"]);
    });

    it("filters by tier with { tier: 'semantic' }", async () => {
      const store = createInMemoryMemoryStore();
      await store.saveWithTier(
        entry("alpha semantic fact"),
        "semantic",
      );
      await store.saveWithTier(
        entry("alpha episodic note"),
        "episodic",
      );

      const results = await store.query("alpha", 10, { tier: "semantic" });
      expect(results.map((e) => e.text)).toEqual(["alpha semantic fact"]);
    });
  });

  describe("createdAt injection", () => {
    it("fills createdAt from the injected clock when missing", async () => {
      const clock = 4242;
      const store = createInMemoryMemoryStore({ now: () => clock });
      const id = await store.save(
        entry("alpha stamped", { scope: { kind: "project", projectId: "p1" } }),
      );

      const results = await store.query("alpha", 10, {
        projectId: "p1",
        includeGlobal: false,
      });
      expect(results[0]?.id).toBe(id);
      expect(results[0]?.createdAt).toBe(clock);
    });
  });

  describe("tier filtering", () => {
    it("should filter by tier via queryByTier", async () => {
      const store = createInMemoryMemoryStore();
      await store.saveWithTier(entry("episodic fact"), "episodic");
      await store.saveWithTier(entry("semantic fact"), "semantic");

      const episodic = await store.queryByTier("fact", 10, "episodic");
      expect(episodic).toHaveLength(1);
      expect(episodic[0]?.text).toBe("episodic fact");

      const semantic = await store.queryByTier("fact", 10, "semantic");
      expect(semantic).toHaveLength(1);
      expect(semantic[0]?.text).toBe("semantic fact");
    });

    it("should return all tiers when tier is undefined", async () => {
      const store = createInMemoryMemoryStore();
      await store.saveWithTier(entry("episodic alpha"), "episodic");
      await store.saveWithTier(entry("semantic alpha"), "semantic");

      const all = await store.queryByTier("alpha", 10);
      expect(all).toHaveLength(2);
    });
  });
});
