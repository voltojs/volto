import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createStore } from "@volto/store-jsonl";
import type { TranscriptEventInput } from "@volto/core";
import { readContextUsageFold } from "../context-usage.js";

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

describe("readContextUsageFold", () => {
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
    const fold = await readContextUsageFold(store, "s1");
    expect(fold).not.toBeNull();
    expect(fold!.anchor).toEqual({ promptTokens: 44, outputTokens: 6 });
    expect(fold!.pendingTokens).toBe(0);
    expect(fold!.header!.systemLayers).toEqual([{ id: "system-prompt", text: "abcdefgh" }]);
    // JSON 可序列化（快照会原样放进 HTTP 响应）
    expect(JSON.parse(JSON.stringify(fold))).toEqual(fold);
  });

  it("returns an empty (not null) fold for a session with no events", async () => {
    const store = await seedSession("s2", []);
    const fold = await readContextUsageFold(store, "s2");
    expect(fold).toEqual({ header: null, anchor: null, pendingTokens: 0 });
  });
});
