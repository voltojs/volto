import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createFileMemoryStore } from "../store.js";
import type { MemoryEntry, MemoryStore } from "@volto/core";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-file-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tempDir, { recursive: true, force: true });
});

function entry(text: string, overrides?: Partial<MemoryEntry>): MemoryEntry {
  return { id: "", text, ...overrides };
}

/** Create a store and a fresh instance over the same rootDir (reload). */
function pair(opts: { maxEntriesPerScope?: number; now?: () => number } = {}): {
  store: MemoryStore;
  reload: () => MemoryStore;
} {
  const make = (): MemoryStore =>
    createFileMemoryStore({
      rootDir: tempDir,
      ...(opts.maxEntriesPerScope !== undefined
        ? { maxEntriesPerScope: opts.maxEntriesPerScope }
        : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  return { store: make(), reload: make };
}

describe("createFileMemoryStore", () => {
  it("generates a non-empty id for id: '' and reload returns the entry", async () => {
    const { store, reload } = pair();
    const id = await store.save(
      entry("alpha fact", { scope: { kind: "project", projectId: "p1" } }),
    );
    expect(id).toBeTruthy();

    const reloaded = reload();
    const results = await reloaded.query("alpha", 10, {
      projectId: "p1",
      includeGlobal: false,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(id);
    expect(results[0]?.text).toBe("alpha fact");
  });

  it("keeps a concurrent cold-start save visible: query and save share one load", async () => {
    const { store, reload } = pair();
    // Both calls hit the same fresh scope at the same time. Without a shared
    // in-flight load, each builds its own index from the same (empty) file,
    // and the query's stale `indexes.set` overwrites the save's applied
    // write — the entry then vanishes from this instance and, after a later
    // compact rewrites the file from the stale map, from disk as well.
    await Promise.all([
      store.save(entry("concurrent fact", { scope: { kind: "project", projectId: "p1" } })),
      store.query("concurrent", 10, { projectId: "p1", includeGlobal: false }),
    ]);

    const after = await store.query("concurrent", 10, {
      projectId: "p1",
      includeGlobal: false,
    });
    expect(after).toHaveLength(1);
    expect(after[0]?.text).toBe("concurrent fact");

    // A fresh instance must see it on disk too (the append reached the file).
    const reloaded = reload();
    const onDisk = await reloaded.query("concurrent", 10, {
      projectId: "p1",
      includeGlobal: false,
    });
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]?.text).toBe("concurrent fact");
  });

  it.skipIf(process.platform === "win32")(
    "keeps the in-memory view unchanged when the append cannot reach disk",
    async () => {
      // A read-only root: the directory already exists so loading works,
      // but the append fails with EACCES — nothing reaches disk.
      const rootDir = path.join(tempDir, "readonly");
      await fs.mkdir(rootDir, { recursive: true, mode: 0o500 });
      const store = createFileMemoryStore({ rootDir });

      await expect(
        store.save(
          entry("phantom fact", { scope: { kind: "project", projectId: "p1" } }),
        ),
      ).rejects.toThrow();

      // The failed write must not leave a phantom entry in the instance
      // view — otherwise a later recall would return a row that was never
      // persisted.
      const visible = await store.query("phantom", 10, {
        projectId: "p1",
        includeGlobal: false,
      });
      expect(visible).toHaveLength(0);
    },
  );

  it("rejects the reserved _global projectId so it cannot alias the global file", async () => {
    const { store } = pair();
    // A project named "_global" would map onto _global.jsonl: its entries
    // would surface in every project's includeGlobal view and its writes
    // would corrupt the shared global scope.
    await expect(
      store.save(entry("sneaky", { scope: { kind: "project", projectId: "_global" } })),
    ).rejects.toThrow(/Invalid projectId/);
    await expect(
      store.query("sneaky", 10, { projectId: "_global", includeGlobal: true }),
    ).rejects.toThrow(/Invalid projectId/);
  });

  it("normalizes a missing tier to semantic so tier filters match across stores", async () => {
    const { store, reload } = pair();
    // An entry saved without a tier must match a tier: "semantic" query —
    // the same answer @volto/memory-inmemory gives (core contract).
    await store.save(entry("tierless alpha", { scope: { kind: "project", projectId: "p1" } }));

    const semantic = await store.query("tierless", 10, {
      projectId: "p1",
      includeGlobal: false,
      tier: "semantic",
    });
    expect(semantic).toHaveLength(1);
    expect(semantic[0]?.tier).toBe("semantic");

    const episodic = await store.query("tierless", 10, {
      projectId: "p1",
      includeGlobal: false,
      tier: "episodic",
    });
    expect(episodic).toHaveLength(0);

    // The normalized tier survives to disk.
    const onDisk = await reload().query("tierless", 10, {
      projectId: "p1",
      includeGlobal: false,
      tier: "semantic",
    });
    expect(onDisk).toHaveLength(1);
  });

  it("isolates projects: p1 query returns p1 + global by default, project-only with includeGlobal: false", async () => {
    const { store } = pair();
    await store.save(
      entry("alpha project one", { scope: { kind: "project", projectId: "p1" } }),
    );
    await store.save(
      entry("alpha project two", { scope: { kind: "project", projectId: "p2" } }),
    );
    await store.save(entry("alpha global fact", { scope: { kind: "global" } }));

    const reloaded = pair().reload();
    const withGlobal = await reloaded.query("alpha", 10, { projectId: "p1" });
    const texts = withGlobal.map((e) => e.text).sort();
    expect(texts).toEqual([
      "alpha global fact",
      "alpha project one",
    ].sort());

    const projectOnly = await reloaded.query("alpha", 10, {
      projectId: "p1",
      includeGlobal: false,
    });
    expect(projectOnly.map((e) => e.text)).toEqual(["alpha project one"]);
  });

  it("treats a missing scope as global", async () => {
    const { store } = pair();
    await store.save(entry("alpha legacy entry"));

    const results = await store.query("alpha", 10, { includeGlobal: true });
    expect(results.map((e) => e.text)).toEqual(["alpha legacy entry"]);
  });

  it("returns global only for an unbound project; never all projects", async () => {
    const { store, reload } = pair();
    await store.save(
      entry("alpha project one", { scope: { kind: "project", projectId: "p1" } }),
    );
    await store.save(entry("alpha global fact", { scope: { kind: "global" } }));

    const reloaded = reload();
    const globalOnly = await reloaded.query("alpha", 10, { includeGlobal: true });
    expect(globalOnly.map((e) => e.text)).toEqual(["alpha global fact"]);

    const empty = await reloaded.query("alpha", 10, { includeGlobal: false });
    expect(empty).toEqual([]);
  });

  it("filters by tier without projectId using global scope only", async () => {
    const { store, reload } = pair();
    await store.save(
      entry("alpha semantic global", { scope: { kind: "global" }, tier: "semantic" }),
    );
    await store.save(
      entry("alpha semantic project", {
        scope: { kind: "project", projectId: "p1" },
        tier: "semantic",
      }),
    );

    const results = await reload().query("alpha", 10, { tier: "semantic" });
    expect(results.map((e) => e.text)).toEqual(["alpha semantic global"]);
  });

  it("no filter returns every entry (advanced/test use only)", async () => {
    const { store, reload } = pair();
    await store.save(
      entry("alpha project one", { scope: { kind: "project", projectId: "p1" } }),
    );
    await store.save(
      entry("alpha project two", { scope: { kind: "project", projectId: "p2" } }),
    );
    await store.save(entry("alpha global fact", { scope: { kind: "global" } }));

    const all = await reload().query("alpha", 10);
    expect(all).toHaveLength(3);
  });

  it("delete writes a tombstone and a reload no longer returns the entry", async () => {
    const { store, reload } = pair();
    const id = await store.save(
      entry("alpha doomed", { scope: { kind: "project", projectId: "p1" } }),
    );
    expect(await store.delete(id)).toBe(true);
    expect(await store.delete(id)).toBe(false);

    const results = await reload().query("alpha", 10, { projectId: "p1" });
    expect(results).toEqual([]);
  });

  it("tolerates a torn line: valid entries still load", async () => {
    const { store, reload } = pair();
    await store.save(
      entry("alpha survivor", { scope: { kind: "project", projectId: "p1" } }),
    );
    const file = path.join(tempDir, "p1.jsonl");
    await fs.appendFile(file, '{"version":1,"op":"upsert","entry":{"id":"torn', "utf-8");

    const results = await reload().query("alpha", 10, { projectId: "p1" });
    expect(results.map((e) => e.text)).toEqual(["alpha survivor"]);
  });

  it("skips an unknown version line with a warning and loads valid entries", async () => {
    const { store, reload } = pair();
    await store.save(
      entry("alpha survivor", { scope: { kind: "project", projectId: "p1" } }),
    );
    const file = path.join(tempDir, "p1.jsonl");
    await fs.appendFile(
      file,
      `${JSON.stringify({
        version: 99,
        op: "upsert",
        entry: { id: "future", text: "from the future" },
      })}\n`,
      "utf-8",
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const results = await reload().query("alpha", 10, { projectId: "p1" });
    expect(warn).toHaveBeenCalled();
    expect(results.map((e) => e.text)).toEqual(["alpha survivor"]);
  });

  it("compacts: op churn past the threshold rewrites the file down to live entries", async () => {
    // Trigger compaction for real: 1200 plain upserts keep ops (1200) below
    // max(1000, live * 3) so they never compact. With a tiny cap every save
    // also writes an eviction tombstone in the same append, so the op count
    // grows by 2 per save and crosses 1000 around save 501 — the file is
    // then rewritten down to the live set.
    let clock = 1000;
    const { store, reload } = pair({ maxEntriesPerScope: 5, now: () => (clock += 10) });
    const scope = { kind: "project", projectId: "p1" } as const;
    for (let i = 0; i < 510; i += 1) {
      await store.save(entry(`alpha churn ${i}`, { scope }));
    }

    const file = path.join(tempDir, "p1.jsonl");
    const raw = await fs.readFile(file, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    // Without compaction this file would hold 1020 rows; the rewrite leaves
    // only the live set plus the handful of rows appended after it.
    expect(lines.length).toBeLessThan(50);

    const live = await store.query("alpha churn", 5, {
      projectId: "p1",
      includeGlobal: false,
    });
    expect(live).toHaveLength(5);

    // The rewrite is faithful: a reload sees exactly the live set.
    const reloaded = await reload().query("alpha churn", 5, {
      projectId: "p1",
      includeGlobal: false,
    });
    expect(reloaded.map((e) => e.text).sort()).toEqual(live.map((e) => e.text).sort());
  });

  it("enforces the per-scope cap by createdAt, keeping the newest entries", async () => {
    let clock = 1000;
    const { store } = pair({ maxEntriesPerScope: 2, now: () => clock });
    await store.save(entry("alpha oldest", { scope: { kind: "project", projectId: "p1" } }));
    clock = 2000;
    await store.save(entry("alpha middle", { scope: { kind: "project", projectId: "p1" } }));
    clock = 3000;
    await store.save(entry("alpha newest", { scope: { kind: "project", projectId: "p1" } }));

    const results = await store.query("alpha", 10, { projectId: "p1", includeGlobal: false });
    expect(results.map((e) => e.text)).toEqual(["alpha newest", "alpha middle"]);
    const ids = results.map((e) => e.id);
    expect(ids).toHaveLength(2);
  });

  it("persists cap evictions so a reload keeps only the newest entries", async () => {
    let clock = 1000;
    const { store, reload } = pair({ maxEntriesPerScope: 2, now: () => clock });
    await store.save(entry("alpha oldest", { scope: { kind: "project", projectId: "p1" } }));
    clock = 2000;
    await store.save(entry("alpha middle", { scope: { kind: "project", projectId: "p1" } }));
    clock = 3000;
    await store.save(entry("alpha newest", { scope: { kind: "project", projectId: "p1" } }));

    const results = await reload().query("alpha", 10, {
      projectId: "p1",
      includeGlobal: false,
    });
    expect(results.map((e) => e.text)).toEqual(["alpha newest", "alpha middle"]);
  });

  it("fills createdAt from the injected clock when missing", async () => {
    const clock = 4242;
    const { store } = pair({ now: () => clock });
    const id = await store.save(
      entry("alpha stamped", { scope: { kind: "project", projectId: "p1" } }),
    );
    const reloaded = pair({ now: () => clock }).reload();
    const results = await reloaded.query("alpha", 10, {
      projectId: "p1",
      includeGlobal: false,
    });
    expect(results[0]?.id).toBe(id);
    expect(results[0]?.createdAt).toBe(clock);
  });

  it.skipIf(process.platform === "win32")(
    "creates memory files with mode 0600",
    async () => {
      const { store } = pair();
      await store.save(
        entry("alpha locked", { scope: { kind: "project", projectId: "p1" } }),
      );
      const file = path.join(tempDir, "p1.jsonl");
      const stat = await fs.stat(file);
      expect(stat.mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "creates the memory directory with mode 0700",
    async () => {
      const nested = path.join(tempDir, "nested");
      const store = createFileMemoryStore({ rootDir: nested });
      await store.save(
        entry("alpha nested", { scope: { kind: "project", projectId: "p1" } }),
      );
      const stat = await fs.stat(nested);
      expect(stat.mode & 0o777).toBe(0o700);
    },
  );
});
