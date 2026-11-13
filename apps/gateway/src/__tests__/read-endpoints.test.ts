import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createStore } from "@voltojs/store-jsonl";
import type { ModelPort } from "@voltojs/core";
import { createServer } from "../server.js";

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
    const { readConversation } = await import("@voltojs/sdk");
    const { asTranscriptReader } = await import("@voltojs/store-jsonl");

    const view = await readConversation(asTranscriptReader(store), "s1");
    expect(view.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(view.messages[1]!.content).toBe("hello");
  });
});

describe("GET /sessions/:id/trajectory", () => {
  it("returns numbered rows with assistant timing", async () => {
    const store = await seed("s1");
    const { readTrajectory } = await import("@voltojs/sdk");
    const { asTranscriptReader } = await import("@voltojs/store-jsonl");

    const view = await readTrajectory(asTranscriptReader(store), "s1");
    const assistant = view.rows.find((r) => r.kind === "assistant")!;
    expect(assistant.metrics!.durationMs).toBe(80);
    expect(view.rows.map((r) => r.index)).toEqual(view.rows.map((_, i) => i + 1));
  });
});

// Text-only model port standing in for the legacy shared agent — these tests
// only exercise read routes, no turn is ever run through it.
const MODEL_PORT: ModelPort = {
  async *stream() {
    yield { type: "text_delta", text: "" };
    yield { type: "done", stopReason: "end_turn" };
  },
};

describe("GET /sessions/:id/events", () => {
  let base = "";
  let launchToken = "";
  let closeServer = async (): Promise<void> => {};
  let chatStore: ReturnType<typeof createStore>;

  beforeEach(async () => {
    // createServer writes its auth secret into the config dir — point
    // VOLTO_CONFIG_DIR at this test's own temp dir (created by the outer
    // beforeEach) so nothing touches the real ~/.volto.
    process.env["VOLTO_CONFIG_DIR"] = tempDir;
    chatStore = createStore({ directory: tempDir });
    const instance = await createServer({ port: 0, modelPort: MODEL_PORT, chatStore });
    await new Promise<void>((resolve) => instance.on("listening", resolve));
    const addr = instance.address();
    base = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;
    launchToken = instance.launchToken;
    closeServer = () => new Promise<void>((resolve) => instance.close(() => resolve()));
  });

  afterEach(async () => {
    await closeServer();
  });

  async function request(method: string, requestPath: string): Promise<{ status: number; body: string }> {
    const response = await fetch(`${base}${requestPath}`, {
      method,
      headers: { Authorization: `Bearer ${launchToken}` },
    });
    return { status: response.status, body: await response.text() };
  }

  it("GET /sessions/:id/events returns raw persisted events", async () => {
    await chatStore.appendEvents(null, "sess-ev", [
      { time: 1, type: "session_meta", data: {} },
      { time: 2, type: "user_message", data: { content: "hi" } },
    ] as never);
    const res = await request("GET", "/sessions/sess-ev/events");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { sessionId: string; events: unknown[] };
    expect(body.sessionId).toBe("sess-ev");
    expect(body.events).toHaveLength(2);
    expect((body.events[1] as { type: string }).type).toBe("user_message");
  });

  it("GET /sessions/:id/events answers 200 + empty for unknown id", async () => {
    const res = await request("GET", "/sessions/nope/events");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).events).toEqual([]);
  });
});
