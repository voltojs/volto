import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createStore, encodeWorkspaceName } from "../index.js";
import type { TranscriptEventInput } from "@volto/core";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-jsonl-events-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

const WORKSPACE = "/Users/leo.zheng/Documents/my_project";

function userEvent(text: string, time: number): TranscriptEventInput {
  return { time, type: "user_message", data: { content: text }, turn: 1 };
}

describe("appendEvents", () => {
  it("assigns contiguous seq starting at 0", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendEvents(WORKSPACE, "s1", [userEvent("a", 1), userEvent("b", 2)]);
    await store.appendEvents(WORKSPACE, "s1", [userEvent("c", 3)]);

    const events = await store.readEvents("s1");
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(events.map((e) => (e.data as { content: string }).content)).toEqual(["a", "b", "c"]);
  });

  it("is a no-op for an empty batch", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendEvents(WORKSPACE, "s1", []);
    expect(await store.readEvents("s1")).toEqual([]);
  });

  it("keeps seq monotonic under concurrent appends to the same session", async () => {
    const store = createStore({ directory: tempDir });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.appendEvents(WORKSPACE, "s1", [userEvent(`m${i}`, i)])),
    );

    const events = await store.readEvents("s1");
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("writes into the workspace-encoded directory", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendEvents(WORKSPACE, "s1", [userEvent("a", 1)]);

    const expected = path.join(tempDir, encodeWorkspaceName(WORKSPACE), "s1.jsonl");
    await expect(fs.stat(expected)).resolves.toBeDefined();
  });

  it("preserves the event's own time rather than the write time", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendEvents(WORKSPACE, "s1", [userEvent("a", 1_700_000_000_000)]);

    const events = await store.readEvents("s1");
    expect(events[0]!.time).toBe(1_700_000_000_000);
  });
});

describe("readEvents", () => {
  it("returns an empty array for an unknown session", async () => {
    const store = createStore({ directory: tempDir });
    expect(await store.readEvents("nope")).toEqual([]);
  });

  it("skips a torn trailing line instead of failing the whole read", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendEvents(WORKSPACE, "s1", [userEvent("a", 1)]);

    const file = path.join(tempDir, encodeWorkspaceName(WORKSPACE), "s1.jsonl");
    await fs.appendFile(file, '{"version":2,"sessionId":"s1","eve', "utf-8");

    const events = await store.readEvents("s1");
    expect(events).toHaveLength(1);
  });
});
