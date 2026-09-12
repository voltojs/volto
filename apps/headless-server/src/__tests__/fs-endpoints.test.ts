import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ModelPort } from "@volto/core";
import { createStore } from "@volto/store-jsonl";
import { createServer } from "../server.js";

const MODEL_PORT: ModelPort = {
  async *stream() {
    yield { type: "text_delta", text: "" };
    yield { type: "done", stopReason: "end_turn" };
  },
};

describe("GET /fs/* endpoints", () => {
  let base = "";
  let launchToken = "";
  let closeServer = async (): Promise<void> => {};
  let projectDir: string;
  let projectId: string;

  beforeEach(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-endpoints-"));
    process.env["VOLTO_CONFIG_DIR"] = tempDir;
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-project-"));
    await fs.writeFile(path.join(projectDir, "README.md"), "hello");
    await fs.mkdir(path.join(projectDir, "src"));
    await fs.writeFile(path.join(projectDir, "src", "a.ts"), "export {};");
    const instance = await createServer({
      port: 0,
      modelPort: MODEL_PORT,
      chatStore: createStore({ directory: tempDir }),
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

  it("GET /fs/tree lists the project root", async () => {
    const res = await get(`/fs/tree?projectId=${projectId}&path=src`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { path: string; entries: Array<{ name: string }> };
    expect(body.path).toBe("src");
    expect(body.entries.map((e) => e.name)).toEqual(["a.ts"]);
  });

  it("GET /fs/tree answers 404 with the shared message for an unknown project", async () => {
    const res = await get("/fs/tree?projectId=nope");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toBe("Unknown project: nope");
  });

  it("GET /fs/tree rejects an escaping path with 400 and the denial signature", async () => {
    const res = await get(`/fs/tree?projectId=${projectId}&path=${encodeURIComponent("../..")}`);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain("escapes the project root");
  });

  it("GET /fs/search returns relative matches and 400 on empty q", async () => {
    const hit = await get(`/fs/search?projectId=${projectId}&q=readme`);
    expect(hit.status).toBe(200);
    expect(JSON.parse(hit.body).matches).toEqual(["README.md"]);
    const empty = await get(`/fs/search?projectId=${projectId}&q=`);
    expect(empty.status).toBe(400);
  });

  it("GET /fs/file returns a text payload, 404 for a missing file, 400 for a directory", async () => {
    const ok = await get(`/fs/file?projectId=${projectId}&path=README.md`);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ kind: "text", content: "hello", truncated: false });

    const missing = await get(`/fs/file?projectId=${projectId}&path=ghost.md`);
    expect(missing.status).toBe(404);

    const dir = await get(`/fs/file?projectId=${projectId}&path=src`);
    expect(dir.status).toBe(400);
  });

  it("requires auth like every other route", async () => {
    const response = await fetch(`${base}/fs/tree?projectId=${projectId}`);
    expect(response.status).toBe(401);
  });
});
