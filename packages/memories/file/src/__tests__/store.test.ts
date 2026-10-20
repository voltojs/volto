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

  it("compacts: line count stays <= max(1000, live * 3) after many upserts/deletes", async () => {
    const { store } = pair();
    for (let i = 0; i < 1200; i += 1) {
      await store.save(
        entry(`alpha entry ${i}`, { scope: { kind: "project", projectId: "p1" } }),
      );
    }
    const first = await store.query("alpha", 5, { projectId: "p1", includeGlobal: false });
    expect(first.length).toBeGreaterThan(0);

    const file = path.join(tempDir, "p1.jsonl");
    const raw = await fs.readFile(file, "utf-8");
    const live = (await store.query("alpha", 5000, { projectId: "p1", includeGlobal: false })).length;
    expect(raw.split("\n").filter((l) => l.trim() !== "").length).toBeLessThanOrEqual(
      Math.max(1000, live * 3),
    );

    const results = await pair().reload().query("alpha", 5, {
      projectId: "p1",
      includeGlobal: false,
    });
    expect(results.length).toBeGreaterThan(0);
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
