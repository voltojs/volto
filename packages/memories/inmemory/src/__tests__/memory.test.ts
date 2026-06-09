import { describe, it, expect } from "vitest";
import { createInMemoryMemoryStore } from "../memory.js";
import type { MemoryEntry } from "@agent-core/core";

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
      await store.save(entry("one"));
      await store.save(entry("two"));
      await store.save(entry("three"));

      const results = await store.query("any", 2);
      expect(results).toHaveLength(2);
    });

    it("should delete entries", async () => {
      const store = createInMemoryMemoryStore();
      const id = await store.save(entry("Delete me"));
      expect(await store.delete(id)).toBe(true);
      expect(await store.delete(id)).toBe(false);
      expect(await store.query("any", 10)).toHaveLength(0);
    });
  });

  describe("tier filtering", () => {
    it("should filter by tier via queryByTier", async () => {
      const store = createInMemoryMemoryStore();
      await store.saveWithTier(entry("episodic fact"), "episodic");
      await store.saveWithTier(entry("semantic fact"), "semantic");

      const episodic = await store.queryByTier("any", 10, "episodic");
      expect(episodic).toHaveLength(1);
      expect(episodic[0]?.text).toBe("episodic fact");

      const semantic = await store.queryByTier("any", 10, "semantic");
      expect(semantic).toHaveLength(1);
      expect(semantic[0]?.text).toBe("semantic fact");
    });

    it("should return all tiers when tier is undefined", async () => {
      const store = createInMemoryMemoryStore();
      await store.saveWithTier(entry("episodic"), "episodic");
      await store.saveWithTier(entry("semantic"), "semantic");

      const all = await store.queryByTier("any", 10);
      expect(all).toHaveLength(2);
    });
  });
});
