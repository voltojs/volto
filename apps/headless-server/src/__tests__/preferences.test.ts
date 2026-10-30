import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelPort } from "@volto/core";
import { createServer, type HeadlessServer } from "../server.js";

const IDLE_MODEL: ModelPort = {
  async *stream() {
    yield { type: "done", stopReason: "end_turn" };
  },
};

let dir: string;
let server: HeadlessServer;
let baseUrl: string;
let token: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-preferences-"));
  process.env["VOLTO_CONFIG_DIR"] = dir;
  server = await createServer({ port: 0, modelPort: IDLE_MODEL });
  token = server.launchToken;
  await new Promise<void>((resolve) => {
    server.on("listening", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(dir, { recursive: true, force: true });
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe("preferences", () => {
  it("starts empty and round-trips a patched default", async () => {
    const empty = await fetch(`${baseUrl}/preferences`, { headers: auth() });
    expect(await empty.json()).toEqual({});

    const put = await fetch(`${baseUrl}/preferences`, {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        defaultPermissionMode: "auto",
        lastProviderId: "p1",
        lastModelId: "m1",
        lastReasoningEffort: "high",
        junk: "ignored",
      }),
    });
    expect(put.status).toBe(200);

    const read = await fetch(`${baseUrl}/preferences`, { headers: auth() });
    expect(await read.json()).toEqual({
      defaultPermissionMode: "auto",
      lastProviderId: "p1",
      lastModelId: "m1",
      lastReasoningEffort: "high",
    });
  });

  it("merges a later patch instead of replacing the file", async () => {
    await fetch(`${baseUrl}/preferences`, {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ lastModelId: "m2" }),
    });
    const read = await fetch(`${baseUrl}/preferences`, { headers: auth() });
    expect(await read.json()).toEqual({
      defaultPermissionMode: "auto",
      lastProviderId: "p1",
      lastModelId: "m2",
      lastReasoningEffort: "high",
    });
  });

  it("writes the defaults to config.json", async () => {
    const raw = await fs.readFile(path.join(dir, "config.json"), "utf8");
    expect(JSON.parse(raw).preferences).toMatchObject({ defaultPermissionMode: "auto" });
  });
});
