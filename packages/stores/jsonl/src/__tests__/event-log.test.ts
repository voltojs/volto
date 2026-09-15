import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createStore, encodeWorkspaceName, TranscriptFormatError } from "../index.js";
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

describe("readSession", () => {
  it("returns folded meta plus the raw events, and does not project", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendEvents(WORKSPACE, "s1", [
      {
        time: 1,
        type: "session_meta",
        data: { projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan" },
      },
      { time: 2, type: "user_message", data: { content: "hi" }, turn: 1 },
      {
        time: 3,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "hello" }], stopReason: "end_turn", durationMs: 5 },
        turn: 1,
        step: 1,
      },
    ]);

    const record = await store.readSession("s1");
    expect(record).toBeDefined();
    expect(record!.meta.modelId).toBe("m1");
    expect(record!.events).toHaveLength(3);
    expect(record!.events.map((e) => e.type)).toEqual([
      "session_meta",
      "user_message",
      "assistant_message",
    ]);
    expect(record!.createdAt).toBe(1);
    expect(record!.updatedAt).toBe(3);
    // Projection belongs to the caller — a store that only does I/O keeps
    // the stores-* type-import-only rule intact.
    expect(record).not.toHaveProperty("messages");
  });

  it("folds a later session_meta over an earlier one", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendEvents(WORKSPACE, "s1", [
      { time: 1, type: "session_meta", data: { projectId: "p1", providerId: null, modelId: "m1", permissionMode: null } },
      { time: 2, type: "session_meta", data: { projectId: "p1", providerId: null, modelId: "m2", permissionMode: null } },
    ]);

    const record = await store.readSession("s1");
    expect(record!.meta.modelId).toBe("m2");
  });

  it("throws TranscriptFormatError on a v1 file", async () => {
    const dir = path.join(tempDir, encodeWorkspaceName(WORKSPACE));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "old.jsonl"),
      JSON.stringify({ uuid: "u1", parentUuid: null, sessionId: "old", timestamp: 1, version: 1, type: "message", message: { id: "m1", role: "user", content: "hi" } }) + "\n",
      "utf-8",
    );

    const store = createStore({ directory: tempDir });
    await expect(store.readSession("old")).rejects.toThrow(TranscriptFormatError);
  });
});

describe("listSessions", () => {
  it("returns readable records and counts unreadable ones instead of throwing", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendEvents(WORKSPACE, "good", [
      { time: 1, type: "user_message", data: { content: "hi" }, turn: 1 },
    ]);

    const dir = path.join(tempDir, encodeWorkspaceName(WORKSPACE));
    await fs.writeFile(
      path.join(dir, "old.jsonl"),
      JSON.stringify({ version: 1, type: "message", sessionId: "old", timestamp: 1 }) + "\n",
      "utf-8",
    );

    const { records, skipped } = await store.listSessions();
    expect(records.map((r) => r.sessionId)).toEqual(["good"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.filePath).toContain("old.jsonl");
  });
});
