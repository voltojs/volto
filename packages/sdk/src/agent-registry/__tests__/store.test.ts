import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createAgentStore, serializeAgentFile } from "../index.js";
import { parseAgentFile } from "../frontmatter.js";

const roots: string[] = [];
async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "volto-agentstore-"));
  roots.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

describe("serializeAgentFile", () => {
  it("round-trips through the parser", () => {
    const spec = {
      name: "searcher",
      description: "finds things",
      tools: ["read_file", "grep"],
      systemPrompt: "You search.\n\nBe brief.",
      policy: { sandbox: "read-only" as const, approval: "ask" as const },
    };
    const parsed = parseAgentFile(serializeAgentFile(spec), "/x.md");
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.spec.name).toBe("searcher");
    expect(parsed.spec.tools).toEqual(["read_file", "grep"]);
    expect(parsed.spec.systemPrompt).toBe("You search.\n\nBe brief.");
  });

  it("preserves frontmatter keys the parser does not own", () => {
    const out = serializeAgentFile({ name: "x" }, { authoredBy: "leo", team: ["a", "b"] });
    expect(out).toContain("authoredBy: leo");
    const parsed = parseAgentFile(out, "/x.md");
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.unknownKeys).toMatchObject({ authoredBy: "leo" });
  });

  it("round-trips responseFormat instead of silently dropping it", () => {
    const spec = {
      name: "structured",
      responseFormat: {
        type: "json" as const,
        schema: { type: "object", properties: { answer: { type: "string" } } },
      },
    };
    const out = serializeAgentFile(spec);
    expect(out).toContain("responseFormat: {type: json, schema: {type: object, properties: {answer: {type: string}}}}");
    const parsed = parseAgentFile(out, "/structured.md");
    if ("error" in parsed) throw new Error(parsed.error);
    // The parser does not own responseFormat; it must survive as an unknownKey.
    expect(parsed.unknownKeys["responseFormat"]).toMatchObject({ type: "json" });
  });

  it("quotes object keys containing structure characters so they round-trip", () => {
    const spec = {
      name: "structured",
      responseFormat: {
        type: "json" as const,
        schema: {
          type: "object",
          properties: { "a,b:c": { type: "string" } },
        },
      },
    };
    const out = serializeAgentFile(spec);
    expect(out).toContain('"a,b:c": {type: string}');
    const parsed = parseAgentFile(out, "/structured.md");
    if ("error" in parsed) throw new Error(parsed.error);
    expect(
      (parsed.unknownKeys["responseFormat"] as { schema: { properties: Record<string, unknown> } })
        .schema.properties,
    ).toMatchObject({ "a,b:c": { type: "string" } });
  });
});

describe("AgentStore", () => {
  async function store() {
    const cwd = await tmp();
    const configDir = await tmp();
    return { cwd, configDir, store: createAgentStore({ cwd, configDir, homeDir: await tmp() }) };
  }

  it("creates a project-level definition under .volto/agents", async () => {
    const { cwd, store: s } = await store();
    const entry = await s.create({ spec: { name: "p1" }, scope: "project" });
    expect(entry.scope).toBe("project");
    expect(entry.filePath).toBe(path.join(cwd, ".volto", "agents", "p1.md"));
    await expect(fs.readFile(entry.filePath!, "utf8")).resolves.toContain("name: p1");
  });

  it("creates a user-level definition under the config dir", async () => {
    const { configDir, store: s } = await store();
    const entry = await s.create({ spec: { name: "u1" }, scope: "user" });
    expect(entry.filePath).toBe(path.join(configDir, "agents", "u1.md"));
  });

  it("refuses to create a duplicate name in the same scope", async () => {
    const { store: s } = await store();
    await s.create({ spec: { name: "dup" }, scope: "project" });
    await expect(s.create({ spec: { name: "dup" }, scope: "project" })).rejects.toThrow(/exists/i);
  });

  it("updates in place and leaves the hand-written extras alone", async () => {
    const { store: s } = await store();
    const created = await s.create({ spec: { name: "keep" }, scope: "project" });
    // Simulate a hand-edited file carrying an unknown key and a body.
    await fs.writeFile(
      created.filePath!,
      `---\nname: keep\nauthoredBy: leo\n---\n\noriginal body\n`,
      "utf8",
    );

    await s.update("project:keep", { name: "keep", description: "now described", systemPrompt: "new body" });

    const raw = await fs.readFile(created.filePath!, "utf8");
    expect(raw).toContain("authoredBy: leo");     // unknown key survives
    expect(raw).toContain("now described");
    expect(raw).toContain("new body");
  });

  it("deletes the file", async () => {
    const { store: s } = await store();
    const created = await s.create({ spec: { name: "gone" }, scope: "project" });
    await expect(s.remove("project:gone")).resolves.toBe(true);
    await expect(fs.access(created.filePath!)).rejects.toThrow();
  });

  it("rejects an update whose spec.name diverges from the id's name", async () => {
    const { store: s } = await store();
    const created = await s.create({ spec: { name: "keep" }, scope: "project" });
    await expect(
      s.update("project:keep", { name: "renamed" }),
    ).rejects.toThrow(/does not match.*name/i);
    // The mismatch must be rejected before any write.
    await expect(fs.readFile(created.filePath!, "utf8")).resolves.toContain("name: keep");
  });

  it("returns undefined / false for an unknown id instead of throwing", async () => {
    const { store: s } = await store();
    await expect(s.update("project:nope", { name: "nope" })).resolves.toBeUndefined();
    await expect(s.remove("project:nope")).resolves.toBe(false);
  });

  it("edits same-named definitions at different scopes independently", async () => {
    const { store: s } = await store();
    const proj = await s.create({ spec: { name: "same", systemPrompt: "project body" }, scope: "project" });
    const user = await s.create({ spec: { name: "same", systemPrompt: "user body" }, scope: "user" });

    await s.update("user:same", { name: "same", systemPrompt: "user body edited" });

    // The scope prefix is what makes the two addressable; editing one must
    // not touch the file backing the other.
    await expect(fs.readFile(proj.filePath!, "utf8")).resolves.toContain("project body");
    await expect(fs.readFile(user.filePath!, "utf8")).resolves.toContain("user body edited");
  });

  it("rejects an id whose name would escape the target directory", async () => {
    const { store: s } = await store();
    await expect(s.remove("project:../../etc/passwd")).resolves.toBe(false);
    await expect(
      s.create({ spec: { name: "../escape" }, scope: "project" }),
    ).rejects.toThrow(/invalid|name/i);
  });
});
