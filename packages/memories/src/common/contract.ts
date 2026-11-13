/**
 * Shared behavioral contract for MemoryStore implementations
 * (@voltojs/memory-file and @voltojs/memory-inmemory).
 *
 * Test-only: this module imports vitest and must never be reachable from the
 * package's runtime entry point. It pins the query-filter truth table from
 * the core MemoryStore contract (spec 2026-10-20 memory-rag §4.1) so both
 * implementations answer identically — including the tier-only branch and
 * the empty-filter-object case, which regression history shows are easy to
 * break silently in one implementation.
 */
import { describe, expect, it } from "vitest";
import type { MemoryEntry, MemoryStore } from "@voltojs/core";

const PROJECT_A = { kind: "project", projectId: "contract-a" } as const;
const PROJECT_B = { kind: "project", projectId: "contract-b" } as const;
const GLOBAL = { kind: "global" } as const;

function entry(text: string, overrides?: Partial<MemoryEntry>): MemoryEntry {
  return { id: "", text, ...overrides };
}

function textsOf(entries: MemoryEntry[]): string[] {
  return entries.map((e) => e.text).sort();
}

/**
 * Register the shared contract suite against a store factory. The factory is
 * invoked once per case, so implementations can create an isolated store
 * (fresh directory / fresh instance) every time.
 */
export function describeMemoryStoreContract(
  label: string,
  makeStore: () => MemoryStore | Promise<MemoryStore>,
): void {
  describe(`${label} — MemoryStore contract`, () => {
    it("no filter returns every entry (advanced/test use only)", async () => {
      const store = await makeStore();
      await store.save(entry("shared alpha", { scope: PROJECT_A }));
      await store.save(entry("shared beta", { scope: GLOBAL }));

      const all = await store.query("shared", 10);
      expect(textsOf(all)).toEqual(["shared alpha", "shared beta"]);
    });

    it("{ projectId } returns project entries plus global entries", async () => {
      const store = await makeStore();
      await store.save(entry("shared alpha fact", { scope: PROJECT_A }));
      await store.save(entry("shared gamma fact", { scope: GLOBAL }));
      await store.save(entry("shared delta fact", { scope: PROJECT_B }));

      const hits = await store.query("shared", 10, { projectId: "contract-a" });
      expect(textsOf(hits)).toEqual(["shared alpha fact", "shared gamma fact"]);
    });

    it("{ projectId, includeGlobal: false } returns project entries only", async () => {
      const store = await makeStore();
      await store.save(entry("shared alpha fact", { scope: PROJECT_A }));
      await store.save(entry("shared gamma fact", { scope: GLOBAL }));

      const hits = await store.query("shared", 10, {
        projectId: "contract-a",
        includeGlobal: false,
      });
      expect(textsOf(hits)).toEqual(["shared alpha fact"]);
    });

    it("{ includeGlobal: true } without projectId returns global entries only", async () => {
      const store = await makeStore();
      await store.save(entry("shared alpha fact", { scope: PROJECT_A }));
      await store.save(entry("shared gamma fact", { scope: GLOBAL }));

      const hits = await store.query("shared", 10, { includeGlobal: true });
      expect(textsOf(hits)).toEqual(["shared gamma fact"]);
    });

    it("{ includeGlobal: false } without projectId returns nothing — never any project", async () => {
      const store = await makeStore();
      await store.save(entry("shared alpha fact", { scope: PROJECT_A }));
      await store.save(entry("shared gamma fact", { scope: GLOBAL }));

      const hits = await store.query("shared", 10, { includeGlobal: false });
      expect(hits).toEqual([]);
    });

    it("a tier-only filter returns global entries of that tier, never project entries", async () => {
      const store = await makeStore();
      await store.save(
        entry("shared gamma fact", { scope: GLOBAL, tier: "semantic" }),
      );
      // Regression pin: a project entry with the same tier must NOT surface
      // through a tier-only filter (no project context exists).
      await store.save(
        entry("shared alpha fact", { scope: PROJECT_A, tier: "semantic" }),
      );

      const hits = await store.query("shared", 10, { tier: "semantic" });
      expect(textsOf(hits)).toEqual(["shared gamma fact"]);
    });

    it("an empty filter object returns nothing", async () => {
      const store = await makeStore();
      await store.save(entry("shared alpha fact", { scope: PROJECT_A }));
      await store.save(entry("shared gamma fact", { scope: GLOBAL }));

      const hits = await store.query("shared", 10, {});
      expect(hits).toEqual([]);
    });

    it("a missing tier normalizes to semantic so tier filters match", async () => {
      const store = await makeStore();
      const id = await store.save(entry("shared tierless fact", { scope: PROJECT_A }));

      const semantic = await store.query("shared", 10, {
        projectId: "contract-a",
        includeGlobal: false,
        tier: "semantic",
      });
      expect(semantic).toHaveLength(1);
      expect(semantic[0]?.id).toBe(id);
      expect(semantic[0]?.tier).toBe("semantic");

      const episodic = await store.query("shared", 10, {
        projectId: "contract-a",
        includeGlobal: false,
        tier: "episodic",
      });
      expect(episodic).toEqual([]);
    });

    it("save with id '' returns the generated id and delete removes the entry", async () => {
      const store = await makeStore();
      const id = await store.save(entry("shared alpha fact", { scope: PROJECT_A }));
      expect(id).toBeTruthy();

      expect(await store.delete(id)).toBe(true);
      const hits = await store.query("shared", 10, {
        projectId: "contract-a",
        includeGlobal: false,
      });
      expect(hits).toEqual([]);
      expect(await store.delete(id)).toBe(false);
    });
  });
}
