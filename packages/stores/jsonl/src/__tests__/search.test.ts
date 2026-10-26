import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createStore } from "../index.js";
import type { JsonlSessionStore } from "../index.js";
import type { TranscriptEventInput } from "@volto/core";

let dir: string;
let store: JsonlSessionStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jsonl-search-"));
  store = createStore({ directory: dir });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function meta(title: string, projectId: string | null) {
  return {
    time: 1,
    type: "session_meta" as const,
    data: { title, projectId, providerId: null, modelId: null, permissionMode: "ask" },
  };
}

async function seed(id: string, title: string, projectId: string | null, user: string, assistant: string, at = 1) {
  const events: TranscriptEventInput[] = [
    meta(title, projectId),
    { time: at, type: "user_message", data: { content: user }, turn: 1 },
    {
      time: at + 1,
      type: "assistant_message",
      data: { content: [{ type: "text", text: assistant }], durationMs: 1 },
      turn: 1,
    },
  ];
  await store.appendEvents(null, id, events);
}

describe("searchSessions", () => {
  it("matches title and message text case-insensitively, including CJK", async () => {
    await seed("s1", "PNPM setup", "p1", "How do I install dependencies?", "Use pnpm install.");
    await seed("s2", "其他会话", "p1", "记忆检索怎么做？", "用 lexical 打分。");

    const titleHit = await store.searchSessions("pnpm");
    expect(titleHit.map((h) => h.sessionId)).toContain("s1");
    expect(titleHit[0]?.matchedIn).toBe("title");

    const bodyHit = await store.searchSessions("DEPENDENCIES");
    expect(bodyHit.find((h) => h.sessionId === "s1")?.matchedIn).toBe("message");

    const cjk = await store.searchSessions("记忆");
    expect(cjk.map((h) => h.sessionId)).toContain("s2");
    expect(cjk[0]?.snippet).toContain("记忆");
  });

  it("excludes subagent sessions and filters by project", async () => {
    await seed("s1", "Alpha", "p1", "alpha question", "alpha answer");
    await seed("s2", "Alpha two", "p2", "alpha question", "alpha answer");
    await store.appendEvents(null, "sub", [
      { ...meta("Alpha sub", "p1"), data: { ...meta("Alpha sub", "p1").data, origin: "subagent" as const } },
      { time: 2, type: "user_message", data: { content: "alpha sub" }, turn: 1 },
    ]);

    const p1 = await store.searchSessions("alpha", { projectId: "p1" });
    expect(p1.map((h) => h.sessionId)).toEqual(["s1"]);
    const all = await store.searchSessions("alpha");
    expect(all.map((h) => h.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  it("does not match tool results, respects limit, and returns a bounded snippet", async () => {
    await store.appendEvents(null, "s1", [
      meta("Tool only", "p1"),
      {
        time: 2,
        type: "tool_result",
        data: {
          callId: "c1",
          content: "secret-token-value",
          isError: false,
          orderInBatch: 0,
        },
        turn: 1,
      },
    ]);
    expect(await store.searchSessions("secret-token-value")).toEqual([]);

    await seed("s10", "one", "p1", "needle here", "needle there", 10);
    await seed("s11", "two", "p1", "needle here", "needle there", 11);
    const limited = await store.searchSessions("needle", { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]!.snippet.length).toBeLessThanOrEqual(162);
  });

  it("treats regex metacharacters as literal text", async () => {
    await seed("s1", "Call (alpha)", "p1", "array[0] access", "ok");
    expect((await store.searchSessions("(alpha")).map((h) => h.sessionId)).toEqual(["s1"]);
    expect((await store.searchSessions("[0]")).map((h) => h.sessionId)).toEqual(["s1"]);
    // A dot must not act as a wildcard: "a.b" matches nothing here.
    expect(await store.searchSessions("a.b")).toEqual([]);
  });

  it("orders results by updatedAt descending", async () => {
    await seed("old", "Sort probe", "p1", "probe text", "ok", 10);
    await seed("new", "Sort probe two", "p1", "probe text", "ok", 99);
    const hits = await store.searchSessions("probe");
    expect(hits.map((h) => h.sessionId)).toEqual(["new", "old"]);
  });

  it("clamps limit into 1..50", async () => {
    for (let i = 0; i < 3; i += 1) {
      await seed(`lim${i}`, "Clamp probe", "p1", "clamp text", "ok", 20 + i);
    }
    const over = await store.searchSessions("clamp", { limit: 10_000 });
    expect(over).toHaveLength(3);
    const under = await store.searchSessions("clamp", { limit: -5 });
    expect(under).toHaveLength(1);
  });

  it("returns [] for an empty query and skips unreadable files", async () => {
    await seed("s1", "Alpha", "p1", "alpha", "alpha");
    expect(await store.searchSessions("   ")).toEqual([]);

    await fs.writeFile(path.join(dir, "broken.jsonl"), "{ not json\n", "utf-8");
    expect(await store.searchSessions("alpha")).toHaveLength(1);
  });
});
