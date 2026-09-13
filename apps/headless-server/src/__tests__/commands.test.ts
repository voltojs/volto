import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ModelPort } from "@volto/core";
import { createStore } from "@volto/store-jsonl";
import { createServer } from "../server.js";
import { BUILT_IN_COMMANDS } from "../commands.js";
import { renderCommand } from "@volto/sdk";

const MODEL_PORT: ModelPort = {
  async *stream() {
    yield { type: "text_delta", text: "" };
    yield { type: "done", stopReason: "end_turn" };
  },
};

describe("BUILT_IN_COMMANDS 与 GET /commands", () => {
  let base = "";
  let launchToken = "";
  let closeServer = async (): Promise<void> => {};

  beforeEach(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "commands-"));
    process.env["VOLTO_CONFIG_DIR"] = tempDir;
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

  it("GET /commands 返回三个内置命令的映射形状", async () => {
    const { status, body } = await get("/commands");
    expect(status).toBe(200);
    const parsed = JSON.parse(body) as { commands: Array<{ name: string; description: string }> };
    expect(parsed.commands.map((c) => c.name)).toEqual(["plan", "review", "explain"]);
    expect(parsed.commands.every((c) => typeof c.description === "string" && c.description.length > 0)).toBe(true);
  });

  it("无凭据 401（与其它端点同一 auth 守卫）", async () => {
    const response = await fetch(`${base}/commands`);
    expect(response.status).toBe(401);
  });

  it("renderCommand 展开 /plan positional 参数；未知命令回包语义不变", () => {
    const rendered = renderCommand(BUILT_IN_COMMANDS, "/plan 加一个深色模式");
    expect(rendered).toContain("制定实施计划");
    expect(rendered).toContain("加一个深色模式");
    expect(renderCommand(BUILT_IN_COMMANDS, "/nope")).toContain("Unknown command: /nope");
  });
});
