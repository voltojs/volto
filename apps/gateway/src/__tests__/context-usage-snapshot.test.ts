import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createStore } from "@voltojs/store-jsonl";
import type { TranscriptEventInput } from "@voltojs/core";
import { readContextUsageSnapshot } from "../context-usage.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-usage-snapshot-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

const WORKSPACE = "/tmp/project";

async function seedSession(id: string, events: TranscriptEventInput[]) {
  const store = createStore({ directory: tempDir });
  await store.appendEvents(WORKSPACE, id, events);
  return store;
}

describe("readContextUsageSnapshot", () => {
  it("folds request_header and assistant usage into a serializable state", async () => {
    const store = await seedSession("s1", [
      { time: 100, type: "user_message", data: { content: "hi" }, turn: 1 },
      {
        time: 110,
        type: "request_header",
        data: {
          hash: "h1",
          systemLayers: [{ id: "system-prompt", text: "abcdefgh" }],
          tools: [],
          params: {},
        },
        turn: 1,
      },
      {
        time: 200,
        type: "assistant_message",
        data: {
          content: [{ type: "text", text: "hello" }],
          stopReason: "end_turn",
          durationMs: 80,
          usage: { inputTokens: 40, outputTokens: 6, cacheReadTokens: 4 },
        },
        turn: 1,
        step: 1,
      },
    ]);
    const snapshot = await readContextUsageSnapshot(store, "s1");
    expect(snapshot).not.toBeNull();
    expect(snapshot.anchor).toEqual({ promptTokens: 44, outputTokens: 6 });
    expect(snapshot.pendingTokens).toBe(0);
    expect(snapshot.headerEstimate).not.toBeNull();
    expect(snapshot.headerEstimate!.layers).toEqual([{ id: "system-prompt", tokens: expect.any(Number) }]);
    // JSON 可序列化（快照会原样放进 HTTP 响应）
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("returns an empty (not null) snapshot for a session with no events", async () => {
    const store = await seedSession("s2", []);
    const snapshot = await readContextUsageSnapshot(store, "s2");
    expect(snapshot).toEqual({ headerEstimate: null, anchor: null, pendingTokens: 0, messageTokens: 0 });
  });
});
