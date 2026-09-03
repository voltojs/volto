import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createStore, encodeWorkspaceName } from "../index.js";
import type { Message } from "@volto/core";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-jsonl-test-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

const userMsg: Message = { role: "user", content: "hello" };
const assistantMsg: Message = { role: "assistant", content: [{ type: "text", text: "hi there" }] };
const WORKSPACE = "/Users/leo.zheng/Documents/my_project";

describe("encodeWorkspaceName", () => {
  it("replaces every non-alphanumeric character with a dash", () => {
    expect(encodeWorkspaceName("/Users/leo.zheng/Documents/github_workspace/volto")).toBe(
      "-Users-leo-zheng-Documents-github-workspace-volto",
    );
  });
});

describe("JsonlSessionStore", () => {
  it("readSession returns undefined for an unknown session", async () => {
    const store = createStore({ directory: tempDir });
    expect(await store.readSession("nope")).toBeUndefined();
  });

  it("round-trips meta and messages", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendMeta(WORKSPACE, "s1", {
      projectId: "p1",
      providerId: "v1",
      modelId: "m1",
      permissionMode: "plan",
    });
    await store.appendMessages(WORKSPACE, "s1", [userMsg, assistantMsg]);

    const record = await store.readSession("s1");
    expect(record).toBeDefined();
    expect(record!.sessionId).toBe("s1");
    expect(record!.meta).toEqual({
      projectId: "p1",
      providerId: "v1",
      modelId: "m1",
      permissionMode: "plan",
    });
    expect(record!.messages).toEqual([userMsg, assistantMsg]);
  });

  it("places a session's file under its workspace's encoded directory", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendMessages(WORKSPACE, "s1", [userMsg]);

    const expectedPath = path.join(tempDir, encodeWorkspaceName(WORKSPACE), "s1.jsonl");
    await expect(fs.stat(expectedPath)).resolves.toBeDefined();
  });

  it("places a session with no workspace at the top level", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendMessages(null, "s1", [userMsg]);

    await expect(fs.stat(path.join(tempDir, "s1.jsonl"))).resolves.toBeDefined();
  });

  it("keeps writing to a session's existing file even when a later call passes a different workspace hint", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendMeta(WORKSPACE, "s1", {
      projectId: "p1",
      providerId: "v1",
      modelId: "m1",
      permissionMode: "plan",
    });
    // A caller that doesn't know (or gets wrong) the workspace on a later
    // call must not fragment the session into a second file.
    await store.appendMessages(null, "s1", [userMsg]);
    await store.appendMessages("/some/other/workspace", "s1", [assistantMsg]);

    const record = await store.readSession("s1");
    expect(record!.messages).toEqual([userMsg, assistantMsg]);

    const workspaceDir = path.join(tempDir, encodeWorkspaceName(WORKSPACE));
    expect(await fs.readdir(workspaceDir)).toEqual(["s1.jsonl"]);
  });

  it("accumulates messages appended across multiple turns", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendMessages(WORKSPACE, "s1", [userMsg]);
    await store.appendMessages(WORKSPACE, "s1", [assistantMsg]);

    const record = await store.readSession("s1");
    expect(record!.messages).toEqual([userMsg, assistantMsg]);
  });

  it("a later appendMeta call updates the effective binding", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendMeta(WORKSPACE, "s1", { projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan" });
    await store.appendMeta(WORKSPACE, "s1", { projectId: "p1", providerId: "v2", modelId: "m2", permissionMode: "auto-accept" });

    const record = await store.readSession("s1");
    expect(record!.meta).toEqual({
      projectId: "p1",
      providerId: "v2",
      modelId: "m2",
      permissionMode: "auto-accept",
    });
  });

  it("records errors without disturbing message history", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendMessages(WORKSPACE, "s1", [userMsg]);
    await store.appendError(WORKSPACE, "s1", "boom");
    await store.appendMessages(WORKSPACE, "s1", [assistantMsg]);

    const record = await store.readSession("s1");
    expect(record!.messages).toEqual([userMsg, assistantMsg]);
    expect(record!.errors).toEqual([{ message: "boom", timestamp: expect.any(Number) }]);
  });

  it("appendMessages is a no-op for an empty array", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendMessages(WORKSPACE, "s1", []);
    expect(await store.readSession("s1")).toBeUndefined();
  });

  it("listSessions finds sessions across workspace directories and the top level", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendMessages(WORKSPACE, "proj/session:1", [userMsg]);
    await store.appendMessages("/another/workspace", "s2", [userMsg]);
    await store.appendMessages(null, "s3", [userMsg]);

    const all = await store.listSessions();
    expect(all.map((r) => r.sessionId).sort()).toEqual(["proj/session:1", "s2", "s3"]);
  });

  it("chains lines via parentUuid instead of leaving them unlinked", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendMessages(WORKSPACE, "s1", [userMsg, assistantMsg]);

    const raw = await fs.readFile(
      path.join(tempDir, encodeWorkspaceName(WORKSPACE), "s1.jsonl"),
      "utf-8",
    );
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as { uuid: string; parentUuid: string | null });
    expect(lines).toHaveLength(2);
    expect(lines[0]!.parentUuid).toBeNull();
    expect(lines[1]!.parentUuid).toBe(lines[0]!.uuid);
  });

  it("skips a corrupted line instead of failing the whole read", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendMessages(WORKSPACE, "s1", [userMsg]);
    await fs.appendFile(
      path.join(tempDir, encodeWorkspaceName(WORKSPACE), "s1.jsonl"),
      "not json\n",
      "utf-8",
    );
    await store.appendMessages(WORKSPACE, "s1", [assistantMsg]);

    const record = await store.readSession("s1");
    expect(record!.messages).toEqual([userMsg, assistantMsg]);
  });

  it("deleteSession removes the file wherever it lives; a repeat delete is a no-op", async () => {
    const store = createStore({ directory: tempDir });
    await store.appendMessages(WORKSPACE, "s1", [userMsg]);
    await store.deleteSession("s1");
    expect(await store.readSession("s1")).toBeUndefined();
    await expect(store.deleteSession("s1")).resolves.toBeUndefined();
  });

  it("does not interleave lines from concurrent appends to the same session", async () => {
    const store = createStore({ directory: tempDir });
    await Promise.all([
      store.appendMessages(WORKSPACE, "s1", [userMsg]),
      store.appendMessages(WORKSPACE, "s1", [assistantMsg]),
      store.appendMeta(WORKSPACE, "s1", { projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan" }),
    ]);

    const raw = await fs.readFile(
      path.join(tempDir, encodeWorkspaceName(WORKSPACE), "s1.jsonl"),
      "utf-8",
    );
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
