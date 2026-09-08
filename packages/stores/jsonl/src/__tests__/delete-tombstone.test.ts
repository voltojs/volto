import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createStore } from "../index.js";
import type { TranscriptEventInput } from "@volto/core";

/**
 * Forces `fs.mkdir` (the call `appendEventBatch` makes right after it
 * resolves the target write path, and right before it enters the per-file
 * write queue) to take real wall-clock time. This is what turns "delete a
 * session while an append is mid-flight" from "only reproduces if the
 * scheduler happens to interleave the two calls just right" into
 * "deterministically reproduces every run": the delay opens a real window
 * between an append's path resolution and its entry into the write queue,
 * long enough for a concurrent `deleteSession` call — which does not touch
 * this mock — to run to completion (find the file, unlink it) before the
 * append gets anywhere near the queue.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return (actual.mkdir as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  };
});

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-jsonl-tombstone-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

const WORKSPACE = "/Users/leo.zheng/Documents/my_project";

function userEvent(text: string, time: number): TranscriptEventInput {
  return { time, type: "user_message", data: { content: text }, turn: 1 };
}

describe("deleteSession racing appendEventBatch", () => {
  it("does not resurrect a session deleted while an append is mid-flight", async () => {
    const store = createStore({ directory: tempDir });

    // Seed the file so it exists before the race starts (this call's own
    // mkdir delay is irrelevant — it happens well before the race below).
    await store.appendEvents(WORKSPACE, "s1", [userEvent("first", 0)]);
    expect(await store.readEvents("s1")).toHaveLength(1);

    // Start a second append. It resolves its write path (the existing file)
    // and then blocks on the mocked, delayed `mkdir` call — i.e. it is
    // "resolved but not yet queued", the exact window the bug lives in.
    const appendPromise = store.appendEvents(WORKSPACE, "s1", [userEvent("second", 1)]);

    // Give the append a moment to get past path resolution and into the
    // mocked mkdir delay, then delete the session while it's stuck there.
    // deleteSession's own path lookup (`fs.stat`, unmocked) and its unlink
    // are real but fast filesystem calls with no artificial delay, so they
    // complete — and its unlink task enters the per-file write queue —
    // well before the append's 40ms mkdir delay elapses.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const deletePromise = store.deleteSession("s1");

    // deleteSession waits for the in-flight append to drain before it
    // resolves, and the append is what's blocked on the mkdir delay, so
    // both must be awaited together.
    await Promise.all([appendPromise, deletePromise]);

    // The session must not have been resurrected: no file, no events.
    expect(await store.readEvents("s1")).toEqual([]);
    const files = await fs.readdir(path.join(tempDir, "-Users-leo-zheng-Documents-my-project")).catch(() => []);
    expect(files).toEqual([]);
  });

  it("still deletes normally when there is no concurrent append", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendEvents(WORKSPACE, "s2", [userEvent("hello", 0)]);
    expect(await store.readEvents("s2")).toHaveLength(1);

    await store.deleteSession("s2");

    expect(await store.readEvents("s2")).toEqual([]);
    expect(await store.readSession("s2")).toBeUndefined();
  });

  it("deleting an unknown session is a no-op and does not throw", async () => {
    const store = createStore({ directory: tempDir });
    await expect(store.deleteSession("does-not-exist")).resolves.toBeUndefined();
  });

  it("does not affect appends to a different session", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendEvents(WORKSPACE, "s3", [userEvent("keep-me", 0)]);
    await store.appendEvents(WORKSPACE, "s4", [userEvent("also-keep-me", 0)]);

    await store.deleteSession("s3");
    // A fresh append to the *other* session, issued right after a delete,
    // must land normally — the tombstone is scoped to the deleted session
    // id only.
    await store.appendEvents(WORKSPACE, "s4", [userEvent("more", 1)]);

    expect(await store.readEvents("s3")).toEqual([]);
    const s4Events = await store.readEvents("s4");
    expect(s4Events).toHaveLength(2);
    expect(s4Events.map((e) => e.seq)).toEqual([0, 1]);
  });
});
