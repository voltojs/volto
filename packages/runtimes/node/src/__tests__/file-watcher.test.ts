import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FileWatchEvent } from "@volto/core";
import { createNodeFileWatcher } from "../file-watcher.js";

const DEFAULT_TIMEOUT_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await sleep(15);
  }
}

/** Probe recursive fs.watch support once; nested tests skip when unavailable. */
const supportsRecursiveWatch = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "volto-rec-probe-"));
  try {
    const w = fs.watch(probeDir, { recursive: true }, () => {});
    w.close();
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
})();

interface Harness {
  root: string;
  watcher: ReturnType<typeof createNodeFileWatcher>;
  batches: FileWatchEvent[][];
  events: FileWatchEvent[];
}

const active: Harness[] = [];

async function createHarness(): Promise<Harness> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "volto-watch-"));
  const watcher = createNodeFileWatcher({ root });
  const batches: FileWatchEvent[][] = [];
  const events: FileWatchEvent[] = [];
  const harness: Harness = { root, watcher, batches, events };
  active.push(harness);
  return harness;
}

function collect(harness: Harness): (batch: FileWatchEvent[]) => void {
  return (batch) => {
    harness.batches.push(batch);
    harness.events.push(...batch);
  };
}

/**
 * Confirm the watcher is live before the real stimulus, then reset
 * collected batches so the warm-up write does not pollute assertions.
 * Avoids depending on FSEvents delivering the first real write instantly.
 */
async function ensureWatching(harness: Harness, name = ".warmup"): Promise<void> {
  await fsp.writeFile(path.join(harness.root, name), "warm");
  await waitFor(() => harness.events.some((e) => e.path === name));
  harness.batches.length = 0;
  harness.events.length = 0;
}

afterEach(async () => {
  while (active.length > 0) {
    const h = active.pop();
    if (!h) break;
    await h.watcher.dispose();
    await fsp.rm(h.root, { recursive: true, force: true });
  }
});

describe("createNodeFileWatcher", () => {
  it("emits an event when a file is written under the watched dir (F-019)", async () => {
    const h = await createHarness();
    const id = await h.watcher.watch({ paths: ["."], debounceMs: 80 }, collect(h));
    expect(id).toMatch(/^watch-\d+$/);
    await ensureWatching(h);

    await fsp.writeFile(path.join(h.root, "hello.txt"), "x");
    await waitFor(() => h.events.some((e) => e.path === "hello.txt"));

    const ev = h.events.find((e) => e.path === "hello.txt");
    expect(ev).toBeDefined();
    expect(ev!.type === "change" || ev!.type === "rename").toBe(true);
  });

  it.skipIf(!supportsRecursiveWatch)(
    "reports workspace-relative forward-slash paths for nested writes (F-019)",
    async () => {
      const h = await createHarness();
      await fsp.mkdir(path.join(h.root, "src", "nested"), { recursive: true });
      await h.watcher.watch({ paths: ["."], debounceMs: 80 }, collect(h));
      await ensureWatching(h);

      await fsp.writeFile(path.join(h.root, "src", "nested", "deep.ts"), "export {};");
      await waitFor(() => h.events.some((e) => e.path === "src/nested/deep.ts"));
    },
  );

  it("debounces multiple rapid writes into a single batch (F-020)", async () => {
    const h = await createHarness();
    await h.watcher.watch({ paths: ["."], debounceMs: 120 }, collect(h));
    await ensureWatching(h);

    // Synchronous writes land in the same debounce window.
    const names = ["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"];
    for (const name of names) {
      fs.writeFileSync(path.join(h.root, name), `data-${name}`);
    }

    await waitFor(() => h.events.length > 0);
    // Allow late OS notifications (which would form a second batch) time to appear.
    await sleep(350);

    // Never fake-green: at least one of the written paths must be present.
    const seen = new Set(h.events.map((e) => e.path));
    const hit = names.filter((n) => seen.has(n));
    expect(hit.length).toBeGreaterThan(0);

    // Debounce contract: fewer batches than raw writes — not one batch per write.
    expect(h.batches.length).toBeGreaterThanOrEqual(1);
    expect(h.batches.length).toBeLessThan(names.length);
  });

  it("dedupes the same path within one batch (F-021)", async () => {
    const h = await createHarness();
    await h.watcher.watch({ paths: ["."], debounceMs: 120 }, collect(h));
    await ensureWatching(h);

    const target = path.join(h.root, "same.txt");
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(target, `v${i}`);
    }

    await waitFor(() => h.events.length > 0);
    await sleep(300);

    const same = h.events.filter((e) => e.path === "same.txt");
    expect(same.length).toBeGreaterThanOrEqual(1);
    // Dedup contract: a path appears at most once inside any single batch.
    for (const batch of h.batches) {
      const paths = batch.map((e) => e.path);
      expect(new Set(paths).size).toBe(paths.length);
    }
    // Coalescing: fewer batches than raw writes.
    expect(h.batches.length).toBeLessThan(5);
  });

  it("glob filter excludes non-matching paths (F-022)", async () => {
    const h = await createHarness();
    await fsp.mkdir(path.join(h.root, "sub"), { recursive: true });
    await h.watcher.watch({ paths: ["."], glob: "**/*.ts", debounceMs: 80 }, collect(h));
    // Warm-up with a matching path so we know glob-accepted events flow.
    await ensureWatching(h, "warm.ts");

    await fsp.writeFile(path.join(h.root, "foo.ts"), "a");
    await waitFor(() => h.events.some((e) => e.path === "foo.ts"));

    await fsp.writeFile(path.join(h.root, "foo.txt"), "b");
    if (supportsRecursiveWatch) {
      await fsp.writeFile(path.join(h.root, "sub", "bar.ts"), "c");
      await fsp.writeFile(path.join(h.root, "sub", "bar.md"), "d");
      await waitFor(() => h.events.some((e) => e.path === "sub/bar.ts"));
    }

    // Give filtered-out paths a chance to wrongly appear.
    await sleep(350);

    const paths = h.events.map((e) => e.path);
    expect(paths).toContain("foo.ts");
    if (supportsRecursiveWatch) {
      expect(paths).toContain("sub/bar.ts");
      expect(paths).not.toContain("sub/bar.md");
    }
    expect(paths).not.toContain("foo.txt");
  });

  it("unwatch stops further events and returns false for unknown ids (F-023)", async () => {
    const h = await createHarness();
    const id = await h.watcher.watch({ paths: ["."], debounceMs: 80 }, collect(h));
    await ensureWatching(h);

    await fsp.writeFile(path.join(h.root, "before.txt"), "1");
    await waitFor(() => h.events.some((e) => e.path === "before.txt"));

    expect(await h.watcher.unwatch(id)).toBe(true);
    expect(await h.watcher.unwatch("nope")).toBe(false);
    expect(await h.watcher.list()).not.toContain(id);

    await fsp.writeFile(path.join(h.root, "after.txt"), "2");
    await sleep(400);

    expect(h.events.some((e) => e.path === "after.txt")).toBe(false);
  });

  it("rejects registration paths that escape the workspace root (F-024)", async () => {
    const h = await createHarness();
    const outside = path.join(os.tmpdir(), `volto-outside-${Date.now()}`);
    await fsp.mkdir(outside, { recursive: true });
    try {
      await expect(
        h.watcher.watch({ paths: ["../outside-escape"], debounceMs: 80 }, collect(h)),
      ).rejects.toThrow(/escape/i);

      await expect(
        h.watcher.watch({ paths: [outside], debounceMs: 80 }, collect(h)),
      ).rejects.toThrow(/escape/i);

      // A legal in-root watch still works after the rejected ones.
      const okId = await h.watcher.watch({ paths: ["."], debounceMs: 80 }, collect(h));
      expect(await h.watcher.list()).toContain(okId);
      await ensureWatching(h);
      await fsp.writeFile(path.join(h.root, "ok.txt"), "x");
      await waitFor(() => h.events.some((e) => e.path === "ok.txt"));
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it("dispose closes every watch and stops all events (F-025)", async () => {
    const h = await createHarness();
    const id1 = await h.watcher.watch({ paths: ["."], debounceMs: 80 }, collect(h));
    const id2 = await h.watcher.watch({ paths: ["."], debounceMs: 80 }, () => {
      throw new Error("callback must be isolated");
    });
    expect(await h.watcher.list()).toEqual(expect.arrayContaining([id1, id2]));
    await ensureWatching(h);

    await fsp.writeFile(path.join(h.root, "pre.txt"), "1");
    await waitFor(() => h.events.some((e) => e.path === "pre.txt"));

    await h.watcher.dispose();
    expect(await h.watcher.list()).toEqual([]);

    await fsp.writeFile(path.join(h.root, "post.txt"), "2");
    await sleep(400);
    expect(h.events.some((e) => e.path === "post.txt")).toBe(false);
  });

  it("callback throw does not crash the adapter (F-025)", async () => {
    const h = await createHarness();
    const id = await h.watcher.watch({ paths: ["."], debounceMs: 80 }, () => {
      throw new Error("host callback boom");
    });

    await fsp.writeFile(path.join(h.root, "boom.txt"), "x");
    await sleep(250);

    // Adapter still alive: list + unwatch work.
    expect(await h.watcher.list()).toContain(id);
    expect(await h.watcher.unwatch(id)).toBe(true);
  });

  it("list returns active watch ids (F-023)", async () => {
    const h = await createHarness();
    const id1 = await h.watcher.watch({ paths: ["."], debounceMs: 80 }, () => {});
    const id2 = await h.watcher.watch({ paths: ["."], debounceMs: 80, glob: "*.ts" }, () => {});
    const ids = await h.watcher.list();
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    expect(ids.length).toBe(2);
  });
});
