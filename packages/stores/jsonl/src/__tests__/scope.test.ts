import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createStore, scopeToWorkspace, encodeWorkspaceName } from "../index.js";
import type { Message } from "@volto/core";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-jsonl-scope-test-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

const WORKSPACE = "/Users/leo.zheng/Documents/my_project";
const userMsg: Message = { role: "user", content: "hello" };

describe("scopeToWorkspace", () => {
  it("forwards appendMessages to the bound workspacePath", async () => {
    const full = createStore({ directory: tempDir });
    const scoped = scopeToWorkspace(full, WORKSPACE);

    await scoped.appendMessages("s1", [userMsg]);

    const expectedPath = path.join(tempDir, encodeWorkspaceName(WORKSPACE), "s1.jsonl");
    await expect(fs.stat(expectedPath)).resolves.toBeDefined();
  });

  it("forwards appendMeta, appendError, and appendTrajectoryEntry to the bound workspacePath", async () => {
    const full = createStore({ directory: tempDir });
    const scoped = scopeToWorkspace(full, WORKSPACE);

    await scoped.appendMeta("s1", { projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan" });
    await scoped.appendError("s1", "boom");
    await scoped.appendTrajectoryEntry("s1", {
      sessionId: "s1",
      turn: 1,
      step: 1,
      timestamp: 1,
      eventType: "tool_result",
      data: {},
    });

    const record = await full.readSession("s1");
    expect(record!.meta.projectId).toBe("p1");
    expect(record!.errors).toEqual([{ message: "boom", timestamp: expect.any(Number) }]);
  });

  it("passes null as the workspacePath when scoped to null", async () => {
    const full = createStore({ directory: tempDir });
    const scoped = scopeToWorkspace(full, null);

    await scoped.appendMessages("s1", [userMsg]);

    await expect(fs.stat(path.join(tempDir, "s1.jsonl"))).resolves.toBeDefined();
  });
});
