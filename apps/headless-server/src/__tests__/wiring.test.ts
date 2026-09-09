import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createWiredAgent, DEFAULT_SYSTEM_PROMPT, buildSandboxConfigs } from "../wiring.js";
import { createMockModelPort, toolCallScript, textScript } from "@volto/core";
import type { ModelPort, ModelRequest } from "@volto/core";
import {
  createNodeFileSystem,
  createNodeShell,
  createSandboxedFileSystem,
  createSandboxedShell,
} from "@volto/runtime-node";

let tempConfigDir: string;
let tempProjectDir: string;
let tempHomeDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

// Captured before any test's beforeEach overrides process.env["HOME"] to a
// dir under os.tmpdir() — the R1 "outside every writable root" test below
// needs a real path that stays outside cwd/tmp/os.tmpdir() even though
// os.homedir() would otherwise track the hijacked $HOME.
const REAL_HOME = os.homedir();

// User-level instruction/skill probing hangs off the REAL home directory
// (os.homedir() honors $HOME on POSIX), so every test needs an isolated
// $HOME — otherwise it picks up whatever ~/.agents or ~/.claude happens to
// contain on the machine running the suite.
beforeEach(async () => {
  tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-config-"));
  tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-project-"));
  tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiring-home-"));
  originalConfigDir = process.env["VOLTO_CONFIG_DIR"];
  process.env["VOLTO_CONFIG_DIR"] = tempConfigDir;
  originalHome = process.env["HOME"];
  process.env["HOME"] = tempHomeDir;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env["VOLTO_CONFIG_DIR"];
  else process.env["VOLTO_CONFIG_DIR"] = originalConfigDir;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  await fs.rm(tempConfigDir, { recursive: true, force: true });
  await fs.rm(tempProjectDir, { recursive: true, force: true });
  await fs.rm(tempHomeDir, { recursive: true, force: true });
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

describe("createWiredAgent skill registry (progressive disclosure)", () => {
  // tempHomeDir is set up in the top-level beforeEach — user-level
  // .agents/.claude hang off the REAL home directory (os.homedir() honors
  // $HOME on POSIX), so it's isolated there for every describe block.

  async function writeSkill(
    root: string,
    subdir: string,
    name: string,
    body: string,
    description: string = `${name} skill`,
  ): Promise<void> {
    const dir = path.join(root, subdir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
      "utf-8",
    );
  }

  function systemContentsOf(requests: ModelRequest[]): string[] {
    return requests[0]!.messages
      .filter((m) => m.role === "system")
      .map((m) => (m as { content: string }).content);
  }

  it("appends a skill-catalog layer with names and descriptions, never bodies", async () => {
    await writeSkill(tempConfigDir, "skills", "alpha", "ALPHA-BODY-SHOULD-NOT-APPEAR");
    const { modelPort, requests } = captureModelPort();

    const agent = createWiredAgent({ modelPort, cwd: tempProjectDir });
    await agent.run("hi");

    const systemContents = systemContentsOf(requests);
    const catalog = systemContents.find((c) => c.startsWith("Available skills (load full instructions with the skill tool):")) ?? "";
    expect(catalog).toContain("- alpha: alpha skill");
    expect(systemContents.some((c) => c.includes("ALPHA-BODY-SHOULD-NOT-APPEAR"))).toBe(false);
  });

  it("loads skill bodies on demand through the skill tool and rereads disk", async () => {
    const skillDir = path.join(tempConfigDir, "skills", "alpha");
    await fs.mkdir(skillDir, { recursive: true });
    const write = (body: string) =>
      fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: alpha\ndescription: alpha skill\n---\n${body}`, "utf-8");
    await write("ALPHA-BODY-V1");

    const requests: ModelRequest[] = [];
    const inner = createMockModelPort([
      toolCallScript("c1", "skill", JSON.stringify({ name: "alpha" })),
      textScript("loaded once"),
      toolCallScript("c2", "skill", JSON.stringify({ name: "alpha" })),
      textScript("loaded twice"),
    ]);
    const modelPort: ModelPort = {
      async *stream(req) {
        requests.push(req);
        yield* inner.stream(req);
      },
    };

    const agent = createWiredAgent({ modelPort, cwd: tempProjectDir });
    await agent.run("load it");
    await write("ALPHA-BODY-V2");
    await agent.run("load it again");

    const toolResults = requests.flatMap((r) => r.messages.filter((m) => m.role === "tool"));
    expect(JSON.stringify(toolResults)).toContain("ALPHA-BODY-V1");
    expect(JSON.stringify(toolResults)).toContain("ALPHA-BODY-V2");
    // 正文不出现在任何 system 层
    const systemContents = requests.flatMap((r) =>
      r.messages.filter((m) => m.role === "system").map((m) => (m as { content: string }).content),
    );
    expect(systemContents.some((c) => c.includes("ALPHA-BODY-V1") || c.includes("ALPHA-BODY-V2"))).toBe(false);
  });

  it("keeps disable-model-invocation skills out of the catalog and loader", async () => {
    const skillDir = path.join(tempConfigDir, "skills", "secret");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: secret\ndescription: secret skill\ndisable-model-invocation: true\n---\nSECRET-BODY",
      "utf-8",
    );
    const requests: ModelRequest[] = [];
    const inner = createMockModelPort([
      toolCallScript("c1", "skill", JSON.stringify({ name: "secret" })),
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

    const systemContents = systemContentsOf(requests);
    expect(systemContents.some((c) => c.includes("secret skill"))).toBe(false);
    const toolResult = requests[1]!.messages.find((m) => m.role === "tool");
    expect(JSON.stringify(toolResult)).toContain("Unknown or non-invocable skill: secret");
    expect(JSON.stringify(toolResult)).not.toContain("SECRET-BODY");
  });

  it("parses CRLF-authored SKILL.md files into the catalog", async () => {
    const skillDir = path.join(tempConfigDir, "skills", "crlf");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\r\nname: crlf\r\ndescription: crlf skill\r\n---\r\nCRLF-BODY",
      "utf-8",
    );
    const { modelPort, requests } = captureModelPort();

    const agent = createWiredAgent({ modelPort, cwd: tempProjectDir });
    await agent.run("hi");

    const systemContents = systemContentsOf(requests);
    const catalog = systemContents.find((c) => c.startsWith("Available skills (load full instructions with the skill tool):")) ?? "";
    expect(catalog).toContain("- crlf: crlf skill");
    expect(systemContents.some((c) => c.includes("CRLF-BODY"))).toBe(false);
  });

  it("dedupes same-named skills across sources (project beats user, .volto beats .claude)", async () => {
    // Same skill name in three of the six sources; the catalog must carry
    // exactly one winner per the six-source priority order: project-level
    // beats user-level, and within a level .volto beats .claude.
    await writeSkill(tempHomeDir, path.join(".claude", "skills"), "dup", "DUP-BODY", "USER-CLAUDE");
    await writeSkill(tempConfigDir, "skills", "dup", "DUP-BODY", "USER-VOLTO");
    await writeSkill(tempProjectDir, path.join(".volto", "skills"), "dup", "DUP-BODY", "PROJECT-WINS");
    const { modelPort, requests } = captureModelPort();

    const agent = createWiredAgent({ modelPort, cwd: tempProjectDir });
    await agent.run("hi");

    // Assertions go through the catalog layer text — bodies never reach context.
    const catalog = systemContentsOf(requests).find((c) => c.startsWith("Available skills")) ?? "";
    expect(catalog).toContain("- dup: PROJECT-WINS");
    expect(catalog).not.toContain("USER-VOLTO");
    expect(catalog).not.toContain("USER-CLAUDE");
    expect(systemContentsOf(requests).some((c) => c.includes("DUP-BODY"))).toBe(false);
  });

  it("treats an empty skill body as a registry miss so the tool reports an error", async () => {
    // Frontmatter-only SKILL.md: parses into the catalog fine, but its body
    // loads as "" — as useless as an entry file that vanished between scan
    // and read. The registry must surface undefined, not an empty hit.
    const skillDir = path.join(tempConfigDir, "skills", "hollow");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: hollow\ndescription: hollow skill\n---\n",
      "utf-8",
    );
    const requests: ModelRequest[] = [];
    const inner = createMockModelPort([
      toolCallScript("c1", "skill", JSON.stringify({ name: "hollow" })),
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

    const toolResult = requests[1]!.messages.find((m) => m.role === "tool");
    expect(JSON.stringify(toolResult)).toContain("Unknown or non-invocable skill: hollow");
  });
});

describe("buildSandboxConfigs (R1 — fs and shell sides share one set of writable roots/overlays)", () => {
  it("no mode: both configs are null (adapters stay undecorated)", () => {
    const { fsConfig, shellConfig } = buildSandboxConfigs(undefined, "/workspace");
    expect(fsConfig).toBeNull();
    expect(shellConfig).toBeNull();
  });

  it("shell config enables network unconditionally, even though the adapter default is disabled", () => {
    const { shellConfig } = buildSandboxConfigs("workspace-write", "/workspace");
    expect(shellConfig?.network).toEqual({ enabled: true });
  });

  it("fs config has no network field at all (a FileSystem port has no egress concept)", () => {
    const { fsConfig } = buildSandboxConfigs("workspace-write", "/workspace");
    expect(fsConfig?.network).toBeUndefined();
  });

  it("both sides drop the .git overlay and keep .env read-only", () => {
    const { fsConfig, shellConfig } = buildSandboxConfigs("workspace-write", "/workspace");
    expect(fsConfig?.readOnlyOverlays).toEqual([".env"]);
    expect(shellConfig?.readOnlyOverlays).toEqual([".env"]);
    expect(fsConfig?.readOnlyOverlays).not.toContain(".git");
    expect(shellConfig?.readOnlyOverlays).not.toContain(".git");
  });

  it("both sides get the identical writable roots: cwd, literal /tmp, and os.tmpdir()", () => {
    const { fsConfig, shellConfig } = buildSandboxConfigs("workspace-write", "/workspace");
    expect(fsConfig?.writableRoots).toEqual(["/workspace", "/tmp", os.tmpdir()]);
    expect(shellConfig?.writableRoots).toEqual(["/workspace", "/tmp", os.tmpdir()]);
  });

  it("read-only mode still gets the same shell-side network/overlay treatment", () => {
    const { shellConfig } = buildSandboxConfigs("read-only", "/workspace");
    expect(shellConfig?.network).toEqual({ enabled: true });
    expect(shellConfig?.readOnlyOverlays).toEqual([".env"]);
  });
});

// ──────────────────────────────────────────────
// R1 (real seatbelt execution, darwin only) — the fs and shell sides of
// buildSandboxConfigs' output are wired through the REAL sandbox adapters
// and actually executed, not just asserted on config values. This is what
// the reviewer's round found missing: overlay enforcement had only ever
// been checked as a string in the config, never exercised through
// sandbox-exec or the fs decorator's real write path.
// ──────────────────────────────────────────────
describe("buildSandboxConfigs — real sandbox execution proves the R1 decision (darwin only)", () => {
  if (process.platform !== "darwin") {
    it.skip("skipped: seatbelt is a macOS-only backend", () => {});
    return;
  }

  const scratchDirs: string[] = [];
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeWorkspace(): string {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "wiring-sandbox-test-"));
    scratchDirs.push(dir);
    return dir;
  }

  /** Build the real shell + fs decorators the gateway wires up for a workspace. */
  function buildReal(cwd: string) {
    const { fsConfig, shellConfig } = buildSandboxConfigs("workspace-write", cwd);
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: cwd }), {
      ...shellConfig!,
      backend: "seatbelt",
    });
    const fs = createSandboxedFileSystem(createNodeFileSystem({ root: cwd }), fsConfig!, { root: cwd });
    return { shell, fs };
  }

  async function drainShell(events: AsyncIterable<{ type: string; code?: number }>): Promise<number | undefined> {
    let code: number | undefined;
    for await (const ev of events) {
      if (ev.type === "exit") code = ev.code;
    }
    return code;
  }

  it("a shell write to .env is refused; a shell write to .git/hooks/post-commit succeeds", async () => {
    const cwd = makeWorkspace();
    fsSync.mkdirSync(path.join(cwd, ".git", "hooks"), { recursive: true });
    fsSync.writeFileSync(path.join(cwd, ".env"), "SECRET=1");
    const { shell } = buildReal(cwd);

    const envWrite = await drainShell(shell.exec(`echo overwritten > .env`));
    expect(envWrite).not.toBe(0);
    expect(fsSync.readFileSync(path.join(cwd, ".env"), "utf-8")).toBe("SECRET=1");

    const hookWrite = await drainShell(
      shell.exec(`echo '#!/bin/sh' > .git/hooks/post-commit`),
    );
    expect(hookWrite).toBe(0);
    expect(fsSync.existsSync(path.join(cwd, ".git", "hooks", "post-commit"))).toBe(true);
  });

  it("an fs.write to .env is refused; an fs.write to .git/hooks/post-commit succeeds (fs side now matches the shell side)", async () => {
    const cwd = makeWorkspace();
    fsSync.mkdirSync(path.join(cwd, ".git", "hooks"), { recursive: true });
    const { fs } = buildReal(cwd);

    await expect(fs.write(".env", "SECRET=1")).rejects.toThrow(/read-only/);
    await expect(fs.write(".git/hooks/post-commit", "#!/bin/sh\n")).resolves.toBeUndefined();
    expect(fsSync.existsSync(path.join(cwd, ".git", "hooks", "post-commit"))).toBe(true);
  });

  it("shell writes to the workspace, /tmp, and os.tmpdir() all succeed; a write outside every root is refused", async () => {
    const cwd = makeWorkspace();
    const { shell } = buildReal(cwd);

    const insideWorkspace = await drainShell(shell.exec(`touch ./inside.txt`));
    expect(insideWorkspace).toBe(0);
    expect(fsSync.existsSync(path.join(cwd, "inside.txt"))).toBe(true);

    const tmpTarget = path.join("/tmp", `wiring-sandbox-probe-${process.pid}.txt`);
    const tmpWrite = await drainShell(shell.exec(`touch "${tmpTarget}"`));
    expect(tmpWrite).toBe(0);
    expect(fsSync.existsSync(tmpTarget)).toBe(true);
    fsSync.rmSync(tmpTarget, { force: true });

    const osTmpTarget = path.join(os.tmpdir(), `wiring-sandbox-probe-${process.pid}.txt`);
    const osTmpWrite = await drainShell(shell.exec(`touch "${osTmpTarget}"`));
    expect(osTmpWrite).toBe(0);
    expect(fsSync.existsSync(osTmpTarget)).toBe(true);
    fsSync.rmSync(osTmpTarget, { force: true });

    // The real $HOME is outside every writable root (cwd / /tmp /
    // os.tmpdir()) — the exact scenario from the task's manual verification
    // list. Uses REAL_HOME (captured at module load) rather than
    // os.homedir(), because this file's top-level beforeEach points $HOME
    // at a directory under os.tmpdir() for unrelated tests, which would
    // make os.homedir() resolve to somewhere INSIDE a writable root here.
    const outsideTarget = path.join(REAL_HOME, `wiring-sandbox-should-fail-${process.pid}.txt`);
    try {
      const outsideWrite = await drainShell(shell.exec(`touch "${outsideTarget}"`));
      expect(outsideWrite).not.toBe(0);
      expect(fsSync.existsSync(outsideTarget)).toBe(false);
    } finally {
      fsSync.rmSync(outsideTarget, { force: true });
    }
  });
});
