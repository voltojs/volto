import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createWiredAgent, DEFAULT_SYSTEM_PROMPT } from "../wiring.js";
import { createMockModelPort, toolCallScript, textScript } from "@volto/core";
import type { ModelPort, ModelRequest } from "@volto/core";

let tempConfigDir: string;
let tempProjectDir: string;
let originalConfigDir: string | undefined;

beforeEach(async () => {
  tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-config-"));
  tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-project-"));
  originalConfigDir = process.env["VOLTO_CONFIG_DIR"];
  process.env["VOLTO_CONFIG_DIR"] = tempConfigDir;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env["VOLTO_CONFIG_DIR"];
  else process.env["VOLTO_CONFIG_DIR"] = originalConfigDir;
  await fs.rm(tempConfigDir, { recursive: true, force: true });
  await fs.rm(tempProjectDir, { recursive: true, force: true });
});

function captureModelPort(): { modelPort: ModelPort; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const inner = createMockModelPort([textScript("ok")]);
  return {
    requests,
    modelPort: {
      async *stream(req) {
        requests.push(req);
        yield* inner.stream(req);
      },
    },
  };
}

describe("createWiredAgent memory file layers", () => {
  it("includes both user and project AGENTS.md as separate system messages", async () => {
    await fs.writeFile(path.join(tempConfigDir, "AGENTS.md"), "User rule", "utf-8");
    await fs.writeFile(path.join(tempProjectDir, "AGENTS.md"), "Project rule", "utf-8");
    const { modelPort, requests } = captureModelPort();

    const agent = createWiredAgent({ modelPort, cwd: tempProjectDir });
    await agent.run("hi");

    const systemContents = requests[0]!.messages
      .filter((m) => m.role === "system")
      .map((m) => (m as { content: string }).content);
    // Provenance headings prefix each layer, so assert by content inclusion
    // (toContain on an array does exact element matching).
    expect(systemContents.some((c) => c.includes("User rule"))).toBe(true);
    expect(systemContents.some((c) => c.includes("Project rule"))).toBe(true);
    // Two distinct messages, not merged into one.
    expect(systemContents.filter((c) => c.includes("rule"))).toHaveLength(2);
  });

  it("expands an @import line to the referenced file's real content", async () => {
    await fs.writeFile(path.join(tempProjectDir, "AGENTS.md"), "@shared-rules.md", "utf-8");
    await fs.writeFile(path.join(tempProjectDir, "shared-rules.md"), "Shared team rule", "utf-8");
    const { modelPort, requests } = captureModelPort();

    const agent = createWiredAgent({ modelPort, cwd: tempProjectDir });
    await agent.run("hi");

    const systemContents = requests[0]!.messages
      .filter((m) => m.role === "system")
      .map((m) => (m as { content: string }).content);
    expect(systemContents.some((c) => c.includes("Shared team rule"))).toBe(true);
    expect(systemContents.some((c) => c.includes("[missing instruction file"))).toBe(false);
  });

  it("falls back to the missing-instruction-file placeholder for an @import that does not resolve", async () => {
    await fs.writeFile(path.join(tempProjectDir, "AGENTS.md"), "@does-not-exist.md", "utf-8");
    const { modelPort, requests } = captureModelPort();

    const agent = createWiredAgent({ modelPort, cwd: tempProjectDir });
    await agent.run("hi");

    const systemContents = requests[0]!.messages
      .filter((m) => m.role === "system")
      .map((m) => (m as { content: string }).content);
    expect(systemContents.some((c) => c.includes("[missing instruction file:"))).toBe(true);
  });

  it("omits a layer entirely when its file does not exist, without erroring", async () => {
    // Neither AGENTS.md file is created in this test.
    const { modelPort, requests } = captureModelPort();

    const agent = createWiredAgent({ modelPort, cwd: tempProjectDir });
    await agent.run("hi");

    const systemContents = requests[0]!.messages
      .filter((m) => m.role === "system")
      .map((m) => (m as { content: string }).content);
    expect(systemContents.some((c) => c.includes("missing instruction file"))).toBe(false);
  });

  it("includes a triggered skill's resource content as its own layer", async () => {
    const skillsDir = path.join(tempProjectDir, ".volto", "skills", "debugging");
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, "SKILL.md"),
      [
        "---",
        "name: debugging",
        "description: Systematic debugging",
        "trigger: bug",
        "---",
        "Follow these debugging steps.",
      ].join("\n"),
      "utf-8",
    );
    const { modelPort, requests } = captureModelPort();

    const agent = createWiredAgent({ modelPort, cwd: tempProjectDir });
    await agent.run("there is a bug in my code");

    const systemContents = requests[0]!.messages
      .filter((m) => m.role === "system")
      .map((m) => (m as { content: string }).content);
    expect(systemContents.some((c) => c.includes("Follow these debugging steps."))).toBe(true);
  });

  it("degrades gracefully instead of failing the turn when a triggered skill's resource file goes missing after discovery", async () => {
    const skillsDir = path.join(tempProjectDir, ".volto", "skills", "debugging");
    await fs.mkdir(skillsDir, { recursive: true });
    const skillPath = path.join(skillsDir, "SKILL.md");
    await fs.writeFile(
      skillPath,
      [
        "---",
        "name: debugging",
        "description: Systematic debugging",
        "trigger: bug",
        "---",
        "Follow these debugging steps.",
      ].join("\n"),
      "utf-8",
    );

    const requests: ModelRequest[] = [];
    const inner = createMockModelPort([textScript("ok"), textScript("still ok")]);
    const modelPort: ModelPort = {
      async *stream(req) {
        requests.push(req);
        yield* inner.stream(req);
      },
    };
    const agent = createWiredAgent({ modelPort, cwd: tempProjectDir });

    // First turn: skills get discovered and cached for the agent instance's
    // lifetime (not triggered by this input, so the resource is not read yet).
    await agent.run("hello");

    // Resource file goes missing mid-session — the cached skill list still
    // references this path.
    await fs.rm(skillPath);

    // Second turn triggers the skill; loading its now-missing resource must
    // degrade gracefully (skip that layer) instead of rejecting agent.run().
    await expect(agent.run("there is a bug in my code")).resolves.toBeDefined();

    const lastRequest = requests[requests.length - 1]!;
    const systemContents = lastRequest.messages
      .filter((m) => m.role === "system")
      .map((m) => (m as { content: string }).content);
    expect(systemContents.some((c) => c.includes("Follow these debugging steps."))).toBe(false);
  });

  it("does not include a skill's resource when its trigger does not match", async () => {
    const skillsDir = path.join(tempProjectDir, ".volto", "skills", "debugging");
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, "SKILL.md"),
      ["---", "name: debugging", "description: Systematic debugging", "trigger: bug", "---", "Debug steps."].join("\n"),
      "utf-8",
    );
    const { modelPort, requests } = captureModelPort();

    const agent = createWiredAgent({ modelPort, cwd: tempProjectDir });
    await agent.run("what's the weather today");

    const systemContents = requests[0]!.messages
      .filter((m) => m.role === "system")
      .map((m) => (m as { content: string }).content);
    expect(systemContents.some((c) => c.includes("Debug steps."))).toBe(false);
  });
});

describe("createWiredAgent project-chain instruction layers", () => {
  it("injects root and subdirectory instruction files when cwd is nested", async () => {
    await fs.mkdir(path.join(tempProjectDir, "src", "lib"), { recursive: true });
    await fs.mkdir(path.join(tempProjectDir, ".git"));
    await fs.writeFile(path.join(tempProjectDir, "AGENTS.md"), "Root rule", "utf-8");
    await fs.writeFile(path.join(tempProjectDir, "src", "lib", "AGENTS.md"), "Deep rule", "utf-8");
    const { modelPort, requests } = captureModelPort();

    const agent = createWiredAgent({ modelPort, cwd: path.join(tempProjectDir, "src", "lib") });
    await agent.run("hi");

    const systemContents = requests[0]!.messages
      .filter((m) => m.role === "system")
      .map((m) => (m as { content: string }).content);
    expect(systemContents).toContain("Instructions from: AGENTS.md\n\nRoot rule");
    expect(systemContents).toContain("Instructions from: src/lib/AGENTS.md\n\nDeep rule");
  });

  it("dedupes a CLAUDE.md that copies the root AGENTS.md across directories", async () => {
    await fs.mkdir(path.join(tempProjectDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempProjectDir, "AGENTS.md"), "same rule", "utf-8");
    await fs.writeFile(path.join(tempProjectDir, "src", "CLAUDE.md"), "same rule\n", "utf-8");
    const { modelPort, requests } = captureModelPort();

    const agent = createWiredAgent({ modelPort, cwd: path.join(tempProjectDir, "src") });
    await agent.run("hi");

    const systemContents = requests[0]!.messages
      .filter((m) => m.role === "system")
      .map((m) => (m as { content: string }).content);
    expect(systemContents.filter((c) => c.includes("same rule"))).toHaveLength(1);
  });

  it("injects a local overlay after the base file of the same directory", async () => {
    await fs.writeFile(path.join(tempProjectDir, "AGENTS.md"), "Base", "utf-8");
    await fs.writeFile(path.join(tempProjectDir, "AGENTS.local.md"), "Local", "utf-8");
    const { modelPort, requests } = captureModelPort();

    const agent = createWiredAgent({ modelPort, cwd: tempProjectDir });
    await agent.run("hi");

    const systemContents = requests[0]!.messages
      .filter((m) => m.role === "system")
      .map((m) => (m as { content: string }).content);
    expect(systemContents).toContain("Instructions from: AGENTS.md\n\nBase");
    expect(systemContents).toContain("Instructions from: AGENTS.local.md\n\nLocal");
  });

  it("still injects a single-level chain when there is no .git marker", async () => {
    await fs.writeFile(path.join(tempProjectDir, "AGENTS.md"), "Lone rule", "utf-8");
    const { modelPort, requests } = captureModelPort();

    const agent = createWiredAgent({ modelPort, cwd: tempProjectDir });
    await agent.run("hi");

    const systemContents = requests[0]!.messages
      .filter((m) => m.role === "system")
      .map((m) => (m as { content: string }).content);
    expect(systemContents).toContain("Instructions from: AGENTS.md\n\nLone rule");
  });
});

describe("createWiredAgent instruction budget override and prompt policy", () => {
  it("honours maxInstructionBytes and surfaces the notice to the model", async () => {
    await fs.writeFile(path.join(tempProjectDir, "AGENTS.md"), "z".repeat(5000), "utf-8");
    const { modelPort, requests } = captureModelPort();

    const agent = createWiredAgent({ modelPort, cwd: tempProjectDir, maxInstructionBytes: 600 });
    await agent.run("hi");

    const systemContents = requests[0]!.messages
      .filter((m) => m.role === "system")
      .map((m) => (m as { content: string }).content);
    const layerText = systemContents.find((c) => c.includes("Instructions from: AGENTS.md")) ?? "";
    expect(new TextEncoder().encode(layerText).length).toBeLessThanOrEqual(600);
    expect(layerText).toContain("Workspace instruction budget 600 bytes:");
  });

  it("declares instruction precedence in the default system prompt", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("advisory context");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("more specific instructions take precedence");
  });
});

describe("createWiredAgent discovered instruction layers from fs touches", () => {
  it("injects a nested chain directory's AGENTS.md on the turn after the model touches it", async () => {
    await fs.mkdir(path.join(tempProjectDir, "src", "lib"), { recursive: true });
    await fs.mkdir(path.join(tempProjectDir, ".git"));
    await fs.writeFile(path.join(tempProjectDir, "AGENTS.md"), "Root rule", "utf-8");
    await fs.writeFile(path.join(tempProjectDir, "src", "lib", "AGENTS.md"), "Deep rule", "utf-8");
    await fs.writeFile(path.join(tempProjectDir, "src", "lib", "x.ts"), "export {};", "utf-8");

    const requests: ModelRequest[] = [];
    // Tool paths are workspace-relative to the agent cwd (…/src), so touching
    // the fixture file means "lib/x.ts" here — exactly what a real model would
    // send. descendantChain() then maps the touch onto …/src/lib.
    const inner = createMockModelPort([
      toolCallScript("c1", "read_file", JSON.stringify({ path: "lib/x.ts" })),
      textScript("read it"),
      textScript("second turn answer"),
    ]);
    const modelPort: ModelPort = {
      async *stream(req) {
        requests.push(req);
        yield* inner.stream(req);
      },
    };

    const agent = createWiredAgent({ modelPort, cwd: path.join(tempProjectDir, "src") });
    await agent.run("look around");
    await agent.run("and now?");

    const systemsByCall = requests.map((req) =>
      req.messages.filter((m) => m.role === "system").map((m) => (m as { content: string }).content),
    );
    // 第 1 次模型调用（首轮）：只有项目链根层，无 discovered。
    expect(systemsByCall[0]?.some((c) => c.includes("Instructions from: AGENTS.md\n\nRoot rule"))).toBe(true);
    expect(systemsByCall[0]?.some((c) => c.includes("src/lib/AGENTS.md"))).toBe(false);
    // 第 3 次模型调用（第二轮）：上一轮 read_file 触达 src/lib → discovered 层出现。
    expect(systemsByCall[2]?.some((c) => c.includes("Instructions from: src/lib/AGENTS.md\n\nDeep rule"))).toBe(true);
  });

  it("does not discover from unstructured tools (bash/glob)", async () => {
    await fs.mkdir(path.join(tempProjectDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempProjectDir, "src", "AGENTS.md"), "Should not appear", "utf-8");

    const requests: ModelRequest[] = [];
    const inner = createMockModelPort([
      toolCallScript("c1", "bash", JSON.stringify({ command: "cat src/AGENTS.md" })),
      textScript("done"),
    ]);
    const modelPort: ModelPort = {
      async *stream(req) {
        requests.push(req);
        yield* inner.stream(req);
      },
    };

    const agent = createWiredAgent({ modelPort, cwd: tempProjectDir });
    await agent.run("go");

    const systems = requests[1]!.messages.filter((m) => m.role === "system");
    expect(systems.some((m) => (m as { content: string }).content.includes("Should not appear"))).toBe(false);
  });
});
