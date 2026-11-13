import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ModelPort, TranscriptEventInput } from "@voltojs/core";
import { createStore } from "@voltojs/stores/jsonl";
import { createServer } from "../server.js";

const MODEL_PORT: ModelPort = {
  async *stream() {
    yield { type: "text_delta", text: "" };
    yield { type: "done", stopReason: "end_turn" };
  },
};

function ev(
  type: TranscriptEventInput["type"],
  data: TranscriptEventInput["data"],
  turn: number,
  step: number,
): TranscriptEventInput {
  return { time: 1, type, data, turn, step } as TranscriptEventInput;
}

describe("GET /file-refs", () => {
  let base = "";
  let launchToken = "";
  let closeServer = async (): Promise<void> => {};
  let store: ReturnType<typeof createStore>;
  let projectDir: string;
  let projectId: string;

  beforeEach(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-refs-"));
    process.env["VOLTO_CONFIG_DIR"] = tempDir;
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-refs-project-"));
    await fs.writeFile(path.join(projectDir, "README.md"), "hello");
    await fs.mkdir(path.join(projectDir, "src"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "src", "a.ts"), "export {};");
    store = createStore({ directory: tempDir });
    const instance = await createServer({
      port: 0,
      modelPort: MODEL_PORT,
      chatStore: store,
    });
    await new Promise<void>((resolve) => instance.on("listening", resolve));
    const addr = instance.address();
    base = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;
    launchToken = instance.launchToken;
    closeServer = () => new Promise<void>((resolve) => instance.close(() => resolve()));

    const created = await fetch(`${base}/projects`, {
      method: "POST",
      headers: { Authorization: `Bearer ${launchToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "proj", path: projectDir }),
    });
    expect(created.status).toBe(201);
    projectId = ((await created.json()) as { id: string }).id;
  });

  afterEach(async () => {
    await closeServer();
  });

  async function get(requestPath: string): Promise<{ status: number; body: string }> {
    const response = await fetch(`${base}${requestPath}`, {
      headers: { Authorization: `Bearer ${launchToken}` },
    });
    return { status: response.status, body: await response.text() };
  }

  it("returns row-keyed annotations for settled turns", async () => {
    await fs.mkdir(path.join(projectDir, "apps", "web", "lib"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "apps", "web", "lib", "fs-api.ts"), "export {};");
    await store.appendEvents(null, "s1", [
      ev("tool_call", { callId: "c1", name: "read_file", input: { path: "apps/web/lib/fs-api.ts" } }, 1, 1),
      ev("assistant_message", { content: [{ type: "text", text: "see `apps/web/lib/fs-api.ts`" }] }, 1, 1),
    ]);
    const res = await get(`/file-refs?projectId=${projectId}&sessionId=s1`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      refs: Array<{ rowKey: string; blockRefs: Array<Array<{ path: string; source: string }>> }>;
    };
    expect(body.refs).toHaveLength(1);
    expect(body.refs[0]?.rowKey).toBe("1:1:a0");
    expect(body.refs[0]?.blockRefs[0]).toHaveLength(1);
    expect(body.refs[0]?.blockRefs[0]?.[0]).toMatchObject({
      path: "apps/web/lib/fs-api.ts",
      source: "exact",
    });
  });

  it("resolves bare names from tool-touched files", async () => {
    await store.appendEvents(null, "s2", [
      ev("tool_call", { callId: "c1", name: "read_file", input: { path: "apps/web/components/chat/MessageBubble.tsx" } }, 1, 1),
      ev("assistant_message", { content: [{ type: "text", text: "see `MessageBubble.tsx`" }] }, 1, 1),
    ]);
    const res = await get(`/file-refs?projectId=${projectId}&sessionId=s2`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      refs: Array<{ blockRefs: Array<Array<{ path: string; source: string; line?: number }>> }>;
    };
    expect(body.refs[0]?.blockRefs[0]?.[0]).toMatchObject({
      path: "apps/web/components/chat/MessageBubble.tsx",
      source: "session",
    });
  });

  it("resolves against the session's project root", async () => {
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "file-refs-project-b-"));
    await fs.mkdir(path.join(dirB, "src"), { recursive: true });
    await fs.writeFile(path.join(dirB, "src", "a.ts"), "export {};");
    const createdB = await fetch(`${base}/projects`, {
      method: "POST",
      headers: { Authorization: `Bearer ${launchToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "proj-b", path: dirB }),
    });
    const projectIdB = ((await createdB.json()) as { id: string }).id;

    // Absolute touched paths relativize against each session's own root.
    await store.appendEvents(null, "sA", [
      ev("tool_call", { callId: "c1", name: "read_file", input: { path: path.join(projectDir, "src", "a.ts") } }, 1, 1),
      ev("assistant_message", { content: [{ type: "text", text: "see `a.ts`" }] }, 1, 1),
    ]);
    await store.appendEvents(null, "sB", [
      ev("tool_call", { callId: "c1", name: "read_file", input: { path: path.join(dirB, "src", "a.ts") } }, 1, 1),
      ev("assistant_message", { content: [{ type: "text", text: "see `a.ts`" }] }, 1, 1),
    ]);
    const a = await get(`/file-refs?projectId=${projectId}&sessionId=sA`);
    const b = await get(`/file-refs?projectId=${projectIdB}&sessionId=sB`);
    const pick = (r: { body: string }): unknown =>
      (JSON.parse(r.body) as { refs: Array<{ blockRefs: unknown[][] }> }).refs[0]?.blockRefs[0]?.[0];
    expect(pick(a)).toMatchObject({ path: "src/a.ts", source: "session" });
    expect(pick(b)).toMatchObject({ path: "src/a.ts", source: "session" });
  });

  it("400 on missing params", async () => {
    expect((await get("/file-refs")).status).toBe(400);
    expect((await get(`/file-refs?projectId=${projectId}`)).status).toBe(400);
    expect((await get("/file-refs?sessionId=s1")).status).toBe(400);
  });

  it("404 on unknown project or session", async () => {
    expect((await get("/file-refs?projectId=nope&sessionId=s1")).status).toBe(404);
    expect((await get(`/file-refs?projectId=${projectId}&sessionId=nope`)).status).toBe(404);
  });
});

describe("createFileRefsService project ownership", () => {
  it("resolves under the session's own project even when the request names another", async () => {
    const rootOwn = await fs.mkdtemp(path.join(os.tmpdir(), "file-refs-own-"));
    await fs.mkdir(path.join(rootOwn, "src"), { recursive: true });
    await fs.writeFile(path.join(rootOwn, "src", "a.ts"), "export {};");
    const rootOther = await fs.mkdtemp(path.join(os.tmpdir(), "file-refs-other-"));
    const { createFileRefsService } = await import("../file-refs.js");
    const { collectTouchedFiles } = await import("../file-refs.js");
    const service = createFileRefsService({
      projectRootFor: async (projectId) =>
        projectId === "pOwn" ? rootOwn : projectId === "pOther" ? rootOther : undefined,
      sessionFor: async () => ({
        projectId: "pOwn",
        events: [
          ev("tool_call", { callId: "c1", name: "read_file", input: { path: path.join(rootOwn, "src", "a.ts") } }, 1, 1),
        ],
        messages: [
          {
            id: "1:1",
            role: "assistant",
            blocks: [{ type: "text", text: "see `a.ts`" }],
          },
        ] as never,
      }),
    });
    // The request names pOther; the session's own project must win.
    const refs = await service.getRefs("pOther", "s1");
    expect(refs[0]?.blockRefs[0]?.[0]).toMatchObject({ path: "src/a.ts", source: "session" });
    void collectTouchedFiles;
  });

  it("ignores directory-scoped tool args and normalizes relative paths", async () => {
    const { collectTouchedFiles } = await import("../file-refs.js");
    const result = collectTouchedFiles(
      [
        ev("tool_call", { callId: "c1", name: "grep", input: { pattern: "x", path: "src" } }, 1, 1),
        ev("tool_call", { callId: "c2", name: "read_file", input: { path: "./src/a.ts" } }, 1, 1),
        ev("tool_call", { callId: "c3", name: "glob", input: { pattern: "src/**" } }, 1, 1),
      ],
      "/root",
    );
    expect(result.all).toEqual(["src/a.ts"]);
    expect(result.byTurn.get("1")).toEqual(["src/a.ts"]);
  });
});
