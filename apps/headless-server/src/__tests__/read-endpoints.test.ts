import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createStore } from "@volto/store-jsonl";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-endpoints-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

const WORKSPACE = "/tmp/project";

async function seed(sessionId: string): Promise<ReturnType<typeof createStore>> {
  const store = createStore({ directory: tempDir });
  await store.appendEvents(WORKSPACE, sessionId, [
    { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
    { time: 110, type: "user_message", data: { content: "hi" }, turn: 1 },
    { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
    {
      time: 200,
      type: "assistant_message",
      data: { content: [{ type: "text", text: "hello" }], stopReason: "end_turn", durationMs: 80 },
      turn: 1,
      step: 1,
    },
    { time: 210, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
  ]);
  return store;
}

describe("GET /sessions/:id", () => {
  it("returns a ConversationView built from the event log", async () => {
    const store = await seed("s1");
    const { readConversation } = await import("@volto/sdk");
    const { asTranscriptReader } = await import("@volto/store-jsonl");

    const view = await readConversation(asTranscriptReader(store), "s1");
    expect(view.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(view.messages[1]!.content).toBe("hello");
  });
});

describe("GET /sessions/:id/trajectory", () => {
  it("returns numbered rows with assistant timing", async () => {
    const store = await seed("s1");
    const { readTrajectory } = await import("@volto/sdk");
    const { asTranscriptReader } = await import("@volto/store-jsonl");

    const view = await readTrajectory(asTranscriptReader(store), "s1");
    const assistant = view.rows.find((r) => r.kind === "assistant")!;
    expect(assistant.metrics!.durationMs).toBe(80);
    expect(view.rows.map((r) => r.index)).toEqual(view.rows.map((_, i) => i + 1));
  });
});
