import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ModelPort } from "@voltojs/core";
import { createStore } from "@voltojs/stores/jsonl";
import { createServer } from "../server.js";
import { BUILT_IN_COMMANDS, builtInCommands } from "../commands.js";
import { renderCommand } from "@voltojs/sdk";

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

  it("GET /commands 返回内置命令的映射形状（/plan 已升级为客户端 action，不再列出）", async () => {
    const { status, body } = await get("/commands");
    expect(status).toBe(200);
    const parsed = JSON.parse(body) as { commands: Array<{ name: string; description: string }> };
    expect(parsed.commands.map((c) => c.name)).toEqual(["review", "explain"]);
    expect(parsed.commands.every((c) => typeof c.description === "string" && c.description.length > 0)).toBe(true);
  });

  it("无凭据 401（与其它端点同一 auth 守卫）", async () => {
    const response = await fetch(`${base}/commands`);
    expect(response.status).toBe(401);
  });

  it("/plan 不再是服务端模板（客户端 action）；未知命令回包语义不变", () => {
    expect(BUILT_IN_COMMANDS.some((c) => c.name === "plan")).toBe(false);
    // /plan 由 web 客户端拦截（enter-plan action），到达服务端即按未知命令回包。
    expect(renderCommand(BUILT_IN_COMMANDS, "/plan 加一个深色模式")).toContain("Unknown command: /plan");
    expect(renderCommand(BUILT_IN_COMMANDS, "/nope")).toContain("Unknown command: /nope");
  });

  it("follows Accept-Language when no preference is stored", async () => {
    const english = await fetch(`${base}/commands`, {
      headers: { Authorization: `Bearer ${launchToken}`, "Accept-Language": "en-US,en;q=0.9" },
    });
    const parsed = (await english.json()) as { commands: Array<{ name: string; description: string }> };
    expect(parsed.commands.find((c) => c.name === "review")?.description).toBe(
      "Review the current changes by severity",
    );
  });
});

describe("builtInCommands", () => {
  it("renders the menu copy in the requested locale", () => {
    const english = builtInCommands("en").find((command) => command.name === "review");
    expect(english?.description).toBe("Review the current changes by severity");
    const chinese = builtInCommands("zh").find((command) => command.name === "review");
    expect(chinese?.description).toBe("按严重程度审查代码改动");
  });
});
