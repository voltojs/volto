import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAgent } from "../create-agent.js";
import { createAutoAllowGate, createNodeFileSystem, createNodeShell } from "@volto/runtime-node";
import {
  createMockModelPort,
  textDelta,
  toolUseStart,
  toolUseDelta,
  usage,
  modelDone,
  extractBlockText,
} from "@volto/core";
import type { ToolResultMessage } from "@volto/core";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "volto-sdk-path-"));
  await fs.mkdir(path.join(root, "src"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("createAgent — cwd anchors path rules", () => {
  it("denies a relative path that only matches once resolved against cwd", async () => {
    const model = createMockModelPort([
      [toolUseStart("call-1", "write_file"), toolUseDelta("call-1", '{"path":"src/.env","content":"SECRET=1"}'), usage(10, 5), modelDone("tool_use")],
      [textDelta("stopped"), modelDone("end_turn")],
    ]);

    const agent = createAgent({
      modelPort: model,
      fs: createNodeFileSystem({ root }),
      shell: createNodeShell({ defaultCwd: root }),
      cwd: root,
      // A permissionConfig without an approvalGate is rejected at Runner
      // construction, even when no call is ever asked about.
      approvalGate: createAutoAllowGate(),
      permissionConfig: {
        sandbox: "workspace-write",
        approval: "ask",
        rules: [{ pathPattern: "**/.env", decision: "deny" }],
      },
    });

    const state = await agent.run("write the env file");
    const toolResultMsg = state.messages.find((m) => m.role === "tool") as ToolResultMessage | undefined;
    const block = toolResultMsg?.content.find((c) => c.type === "tool_result");
    expect(block?.isError).toBe(true);
    expect(extractBlockText(block!)).toContain("write_file");
    await expect(fs.readFile(path.join(root, "src", ".env"), "utf-8")).rejects.toThrow();
  });
});
