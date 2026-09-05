import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createStore } from "../index.js";
import type { TranscriptEventInput } from "@volto/core";

/**
 * Forces every `fs.readFile` call (in this file's module graph only, so it
 * does not affect other test files) to take a bit of wall-clock time. This is
 * what turns the "20 concurrent appends" test below from "probably exercises
 * the race, if the disk happens to be slow enough" into "guaranteed to
 * exercise it": under a broken implementation that reads the last seq
 * *outside* the per-file write queue, all 20 reads would now overlap every
 * time, regardless of local filesystem speed. Under the correct
 * implementation (read-then-write inside `enqueue`'s callback) the delay
 * only makes each queued append take longer serially — it introduces no
 * race, since the queue does not let a second append's read start until the
 * first append's write has landed.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return (actual.readFile as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  };
});

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-jsonl-concurrency-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

const WORKSPACE = "/Users/leo.zheng/Documents/my_project";

function userEvent(text: string, time: number): TranscriptEventInput {
  return { time, type: "user_message", data: { content: text }, turn: 1 };
}

describe("appendEvents under forced read/write overlap", () => {
  it("still assigns contiguous seq when reads are slow enough to guarantee overlap", async () => {
    const store = createStore({ directory: tempDir });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.appendEvents(WORKSPACE, "s1", [userEvent(`m${i}`, i)])),
    );

    const events = await store.readEvents("s1");
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});
