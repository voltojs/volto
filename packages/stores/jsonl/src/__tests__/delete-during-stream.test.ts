import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createStore } from "../index.js";
import type { TranscriptEventInput } from "@volto/core";

/**
 * Delays every `fs.mkdir` call so that appends fired back-to-back genuinely
 * overlap in flight, reproducing a streaming turn: the recorder appends one
 * event at a time, with the next append starting before the previous one's
 * write has landed. This is what used to keep `inFlightAppends`'s count
 * continuously non-zero and hang `waitForAppendsToDrain` forever.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return (actual.mkdir as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  };
});

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-jsonl-stream-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function userEvent(text: string, time: number): TranscriptEventInput {
  return { time, type: "user_message", data: { content: text }, turn: 1 };
}

describe("deleteSession while a session keeps streaming appends", () => {
  it("resolves promptly and the session stays deleted, even though appends never stop arriving", async () => {
    // A short drain timeout so this test doesn't need to wait out the
    // production default (5000ms) to prove `deleteSession` is bounded — the
    // stream below runs well past this timeout without stopping on its own.
    const store = createStore({ directory: tempDir, appendDrainTimeoutMs: 60 });
    const workspace = tempDir;

    let stop = false;
    let i = 0;
    const pending: Array<Promise<void>> = [];
    // Fires a new append every 5ms without waiting for the previous one to
    // land. With the 30ms mkdir delay above, several appends are genuinely
    // in flight at once at any given moment — the old "wait until the
    // in-flight count reaches zero" semantics could never resolve while this
    // keeps running.
    const timer = setInterval(() => {
      if (stop) return;
      pending.push(store.appendEvents(workspace, "s1", [userEvent(`chunk-${i}`, i)]));
      i += 1;
    }, 5);

    // Let several overlapping appends get in flight before deleting.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const start = Date.now();
    await store.deleteSession("s1");
    const elapsed = Date.now() - start;

    // Stop the stream immediately — synchronously, with no `await` in
    // between — so nothing new can start after the tombstone this call just
    // removed. Anything already fired is captured in `pending`.
    stop = true;
    clearInterval(timer);
    await Promise.allSettled(pending);

    // Must not have hung waiting for the (never-ending) stream to stop: the
    // returned promise is bounded by `appendDrainTimeoutMs`, not by "appends
    // have stopped entirely".
    expect(elapsed).toBeLessThan(500);

    // Every append fired while the stream was running — whether already in
    // flight when deleteSession was called, or fired in the brief window
    // before `stop` took effect — must have been a no-op: the tombstone
    // itself is not removed until the real, unbounded drain completes, so it
    // stayed set for the whole window that mattered even though the call
    // above already returned.
    expect(await store.readEvents("s1")).toEqual([]);
  });
});
