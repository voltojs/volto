import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createStore, scopeToWorkspace, encodeWorkspaceName } from "../index.js";
import type { TranscriptEventInput } from "@volto/core";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-jsonl-scope-test-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

const WORKSPACE = "/Users/leo.zheng/Documents/my_project";

function userEvent(text: string, time: number): TranscriptEventInput {
  return { time, type: "user_message", data: { content: text }, turn: 1 };
}

describe("scopeToWorkspace", () => {
  it("forwards appendEvents to the bound workspacePath", async () => {
    const full = createStore({ directory: tempDir });
    const scoped = scopeToWorkspace(full, WORKSPACE);

    await scoped.appendEvents("s1", [userEvent("a", 1)]);

    const expectedPath = path.join(tempDir, encodeWorkspaceName(WORKSPACE), "s1.jsonl");
    await expect(fs.stat(expectedPath)).resolves.toBeDefined();
  });

  it("round-trips events written through the scoped view, seq intact", async () => {
    const full = createStore({ directory: tempDir });
    const scoped = scopeToWorkspace(full, WORKSPACE);

    await scoped.appendEvents("s1", [userEvent("a", 1), userEvent("b", 2)]);

    const events = await full.readEvents("s1");
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(events.map((e) => (e.data as { content: string }).content)).toEqual(["a", "b"]);
  });

  it("passes null as the workspacePath when scoped to null, writing to the top level", async () => {
    const full = createStore({ directory: tempDir });
    const scoped = scopeToWorkspace(full, null);

    await scoped.appendEvents("s1", [userEvent("a", 1)]);

    await expect(fs.stat(path.join(tempDir, "s1.jsonl"))).resolves.toBeDefined();
    // Must not also land under some workspace-encoded directory.
    const entries = await fs.readdir(tempDir, { withFileTypes: true });
    expect(entries.filter((e) => e.isDirectory())).toHaveLength(0);
  });
});
