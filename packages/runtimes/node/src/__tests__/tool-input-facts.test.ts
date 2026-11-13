import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition } from "@voltojs/core";
import { createToolInputFactResolver } from "../tool-input-facts.js";

const writeTool: ToolDefinition = {
  name: "write_file",
  description: "write",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  requires: [],
  riskTier: "WRITE_HIGH",
  pathInputs: ["path"],
};

const fetchTool: ToolDefinition = {
  name: "web_fetch",
  description: "fetch",
  inputSchema: { type: "object", properties: { url: { type: "string" } } },
  requires: [],
  riskTier: "READ_ONLY",
  hostInputs: ["url"],
};

const bashTool: ToolDefinition = {
  name: "bash",
  description: "run",
  inputSchema: { type: "object", properties: { command: { type: "string" } } },
  requires: [],
  riskTier: "WRITE_HIGH",
};

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "volto-facts-"));
  root = path.join(base, "proj");
  outside = path.join(base, "outside");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

describe("createToolInputFactResolver", () => {
  it("returns undefined for a tool that declares no parameter inputs", async () => {
    const resolver = createToolInputFactResolver(root);
    expect(await resolver.resolve(bashTool, { command: "rm -rf /" })).toBeUndefined();
  });

  it("resolves a relative path to an absolute real path plus its relative form", async () => {
    const resolver = createToolInputFactResolver(root);
    const facts = await resolver.resolve(writeTool, { path: "src/.env" });
    expect(facts?.paths).toHaveLength(1);
    const entry = facts!.paths![0]!;
    expect(path.isAbsolute(entry.absolute)).toBe(true);
    expect(entry.relative).toBe(path.join("src", ".env"));
    // The real root and the real target agree, so no `..` leaks in.
    expect(entry.relative.startsWith("..")).toBe(false);
  });

  it("normalizes .. lexically and reports a path that leaves the workspace", async () => {
    const resolver = createToolInputFactResolver(root);
    const facts = await resolver.resolve(writeTool, { path: "src/../../../etc/passwd" });
    const entry = facts!.paths![0]!;
    expect(entry.absolute.endsWith(path.join("etc", "passwd"))).toBe(true);
    expect(entry.relative.startsWith("..")).toBe(true);
  });

  it("collapses an inner .. so the same file matches the same rule either way", async () => {
    const resolver = createToolInputFactResolver(root);
    const facts = await resolver.resolve(writeTool, { path: "src/../src/.env" });
    expect(facts!.paths![0]!.relative).toBe(path.join("src", ".env"));
  });

  it("follows a symlinked directory when resolving", async () => {
    await fs.symlink(outside, path.join(root, "link"));
    const resolver = createToolInputFactResolver(root);
    const facts = await resolver.resolve(writeTool, { path: "link/secret.txt" });
    const entry = facts!.paths![0]!;
    expect(entry.absolute.startsWith(await fs.realpath(outside))).toBe(true);
  });

  it("keeps the lexical tail for a path that does not exist yet", async () => {
    const resolver = createToolInputFactResolver(root);
    const facts = await resolver.resolve(writeTool, { path: "new/nested/file.txt" });
    expect(facts!.paths![0]!.relative).toBe(path.join("new", "nested", "file.txt"));
  });

  it("resolves every entry of an array-valued path input", async () => {
    const watchTool: ToolDefinition = { ...writeTool, name: "watch_files", pathInputs: ["paths"] };
    const resolver = createToolInputFactResolver(root);
    const facts = await resolver.resolve(watchTool, { paths: ["a.txt", "b/c.txt"] });
    expect(facts!.paths).toHaveLength(2);
    expect(facts!.paths!.map((entry) => entry.relative)).toEqual(["a.txt", path.join("b", "c.txt")]);
  });

  it("extracts a lowercased hostname from a URL input", async () => {
    const resolver = createToolInputFactResolver(root);
    const facts = await resolver.resolve(fetchTool, { url: "https://DB.Internal.Example:8443/x" });
    expect(facts?.hosts).toEqual([{ field: "url", host: "db.internal.example" }]);
  });

  it("yields no host fact for an unparseable URL or a non-string value", async () => {
    const resolver = createToolInputFactResolver(root);
    expect(await resolver.resolve(fetchTool, { url: "not a url" })).toBeUndefined();
    expect(await resolver.resolve(fetchTool, { url: 42 })).toBeUndefined();
  });

  it("does not resolve a literal ~ (producers expand it, core must not guess)", async () => {
    const resolver = createToolInputFactResolver(root);
    expect(await resolver.resolve(writeTool, { path: "~/.ssh/id_rsa" })).toBeUndefined();
  });
});
