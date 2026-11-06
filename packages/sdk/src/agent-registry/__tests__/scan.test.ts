import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { scanAgentSources } from "../scan.js";

const roots: string[] = [];
async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "volto-agents-"));
  roots.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

async function writeAgent(dir: string, name: string, body = "prompt"): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: d-${name}\n---\n\n${body}\n`,
    "utf8",
  );
}

describe("scanAgentSources", () => {
  it("prefers a project definition over a same-named user definition", async () => {
    const cwd = await tmp();
    const configDir = await tmp();
    await writeAgent(path.join(configDir, "agents"), "searcher", "user version");
    await writeAgent(path.join(cwd, ".volto", "agents"), "searcher", "project version");

    const { entries } = await scanAgentSources({ cwd, configDir });
    const winner = entries.find((e) => e.spec.name === "searcher" && !e.shadowed);
    expect(winner?.scope).toBe("project");
    expect(winner?.spec.systemPrompt).toBe("project version");
  });

  it("marks the losing definition as shadowed instead of dropping it", async () => {
    const cwd = await tmp();
    const configDir = await tmp();
    await writeAgent(path.join(configDir, "agents"), "searcher");
    await writeAgent(path.join(cwd, ".volto", "agents"), "searcher");

    const { entries } = await scanAgentSources({ cwd, configDir });
    const all = entries.filter((e) => e.spec.name === "searcher");
    expect(all).toHaveLength(2);
    expect(all.filter((e) => e.shadowed)).toHaveLength(1);
    expect(all.find((e) => e.shadowed)?.scope).toBe("user");
  });

  it("reads only .volto/agents, never the .claude or .agents compat dirs", async () => {
    const cwd = await tmp();
    const configDir = await tmp();
    await writeAgent(path.join(cwd, ".claude", "agents"), "proj-claude");
    await writeAgent(path.join(cwd, ".agents", "agents"), "proj-agents");
    await writeAgent(path.join(configDir, ".claude", "agents"), "user-claude");
    await writeAgent(path.join(configDir, "agents"), "only-user", "user version");
    await writeAgent(path.join(cwd, ".volto", "agents"), "only-project", "project version");

    const { entries } = await scanAgentSources({ cwd, configDir });
    expect(entries.map((e) => e.spec.name).sort()).toEqual(["only-project", "only-user"]);
  });

  it("includes plugin specs at the lowest priority", async () => {
    const cwd = await tmp();
    await writeAgent(path.join(cwd, ".volto", "agents"), "dup", "file version");

    const { entries } = await scanAgentSources({
      cwd,
      configDir: await tmp(),
      pluginSpecs: [
        { name: "dup", systemPrompt: "plugin version" },
        { name: "only-plugin", systemPrompt: "p" },
      ],
    });

    expect(entries.find((e) => e.spec.name === "dup" && !e.shadowed)?.scope).toBe("project");
    expect(entries.find((e) => e.spec.name === "dup" && e.shadowed)?.scope).toBe("plugin");
    expect(entries.find((e) => e.spec.name === "only-plugin")?.shadowed).toBe(false);
  });

  it("skips a malformed file and keeps the rest usable", async () => {
    const cwd = await tmp();
    const dir = path.join(cwd, ".volto", "agents");
    await writeAgent(dir, "good");
    await fs.writeFile(path.join(dir, "bad.md"), "no frontmatter here", "utf8");

    const { entries, warnings } = await scanAgentSources({
      cwd, configDir: await tmp(),
    });

    expect(entries.map((e) => e.spec.name)).toContain("good");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bad.md");
  });

  it("rereads the directory on every call so new files appear", async () => {
    const cwd = await tmp();
    const configDir = await tmp();
    const dir = path.join(cwd, ".volto", "agents");
    await writeAgent(dir, "first");

    const before = await scanAgentSources({ cwd, configDir });
    expect(before.entries).toHaveLength(1);

    await writeAgent(dir, "second");
    const after = await scanAgentSources({ cwd, configDir });
    expect(after.entries).toHaveLength(2);
  });

  it("assigns ids as scope:name", async () => {
    const cwd = await tmp();
    await writeAgent(path.join(cwd, ".volto", "agents"), "searcher");
    const { entries } = await scanAgentSources({
      cwd, configDir: await tmp(),
      pluginSpecs: [{ name: "plugged", systemPrompt: "p" }],
    });
    expect(entries.find((e) => e.spec.name === "searcher")?.id).toBe("project:searcher");
    expect(entries.find((e) => e.spec.name === "plugged")?.id).toBe("plugin:plugged");
  });

  it("carries filePath and unknownKeys for file-backed entries", async () => {
    const cwd = await tmp();
    const dir = path.join(cwd, ".volto", "agents");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "tagged.md"),
      "---\nname: tagged\ncustomKey: keep-me\n---\n\nbody\n",
      "utf8",
    );
    const { entries } = await scanAgentSources({
      cwd, configDir: await tmp(),
    });
    const entry = entries.find((e) => e.spec.name === "tagged");
    expect(entry?.filePath).toBe(path.join(dir, "tagged.md"));
    expect(entry?.unknownKeys).toEqual({ customKey: "keep-me" });
  });

  it("warns on declared tool names outside the known set when one is provided", async () => {
    const cwd = await tmp();
    const configDir = await tmp();
    const dir = path.join(cwd, ".volto", "agents");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "imported.md"),
      "---\nname: imported\ntools: [read_file, run_bash_command, search_files]\n---\n\nbody\n",
      "utf8",
    );
    // vl3ierhqx: a definition imported from another product names tools that
    // do not exist in volto; the intersection silently dropped them.
    const known = new Set(["read_file", "write_file", "grep"]);
    const { warnings } = await scanAgentSources({ cwd, configDir, knownToolNames: known });
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes("run_bash_command"))).toBe(true);
    expect(warnings.some((w) => w.includes("search_files"))).toBe(true);
  });

  it("does not warn on tool names when no known set is provided", async () => {
    const cwd = await tmp();
    const configDir = await tmp();
    const dir = path.join(cwd, ".volto", "agents");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "imported.md"),
      "---\nname: imported\ntools: [read_file, nonexistent]\n---\n\nbody\n",
      "utf8",
    );
    const { warnings } = await scanAgentSources({ cwd, configDir });
    expect(warnings).toHaveLength(0);
  });
});
