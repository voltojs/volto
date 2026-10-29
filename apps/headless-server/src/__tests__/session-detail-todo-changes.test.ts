import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createStore } from "@volto/store-jsonl";
import type { ModelPort } from "@volto/core";
import { createServer, type HeadlessServer } from "../server.js";

let dir: string;
let server: HeadlessServer;
let baseUrl: string;
let token: string;

const IDLE_MODEL: ModelPort = {
  async *stream() {
    yield { type: "done", stopReason: "end_turn" };
  },
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-todochanges-"));
  process.env["VOLTO_CONFIG_DIR"] = dir;
  const store = createStore({ directory: path.join(dir, "sessions") });
  await store.appendEvents("/tmp/project", "s1", [
    { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
    {
      time: 110,
      type: "todoListUpdated",
      data: {
        todos: [{ content: "a", status: "in_progress" }],
        counts: { pending: 0, inProgress: 1, completed: 0 },
      },
      turn: 1,
    },
    {
      time: 120,
      type: "todoListUpdated",
      data: {
        todos: [{ content: "a", status: "completed" }],
        counts: { pending: 0, inProgress: 0, completed: 1 },
      },
      turn: 1,
    },
    { time: 130, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
  ]);
  await store.appendEvents("/tmp/project", "s2", [
    { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
    { time: 110, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
  ]);
  server = await createServer({ port: 0, modelPort: IDLE_MODEL });
  token = server.launchToken;
  await new Promise<void>((resolve) => {
    server.on("listening", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(dir, { recursive: true, force: true });
});

describe("GET /sessions/:id todoChanges", () => {
  it("returns the derived transitions", async () => {
    const res = await fetch(`${baseUrl}/sessions/s1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      todos: Array<{ content: string; status: string }>;
      todoChanges: Array<{
        turn?: number;
        time: number;
        transition: { kind: string; content: string };
      }>;
    };
    expect(body.todos).toEqual([{ content: "a", status: "completed" }]);
    expect(body.todoChanges).toEqual([
      { turn: 1, time: 120, transition: { kind: "completed", content: "a" } },
    ]);
  });

  it("returns an empty list for a session that never wrote todos", async () => {
    const res = await fetch(`${baseUrl}/sessions/s2`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { todoChanges: unknown[] };
    expect(body.todoChanges).toEqual([]);
  });
});
