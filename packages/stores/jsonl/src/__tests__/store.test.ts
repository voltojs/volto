import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createStore, encodeWorkspaceName } from "../index.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-jsonl-test-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

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
});
