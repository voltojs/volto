import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe("collectInstructionFiles user level", () => {
  let home: string;
  let project: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "volto-instr-"));
    home = path.join(base, "home");
    project = path.join(base, "project");
    await fs.mkdir(path.join(home, ".agents"), { recursive: true });
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.mkdir(path.join(project, ".git"), { recursive: true });
    // os.homedir() honors $HOME on POSIX — point it at a temp home rather
    // than spying on the os module (see wiring.test.ts for precedent; a
    // namespace-object spy on "node:os" is unreliable under ESM).
    originalHome = process.env["HOME"];
    process.env["HOME"] = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
  });

  it("reads ~/.agents/AGENTS.md and ~/.claude/CLAUDE.md, tagged as user origin", async () => {
    await fs.writeFile(path.join(home, ".agents", "AGENTS.md"), "agents rules");
    await fs.writeFile(path.join(home, ".claude", "CLAUDE.md"), "claude rules");
    const { collectInstructionFiles } = await import("../instructions.js");

    const loaded = await collectInstructionFiles(project, []);
    const user = loaded.filter((f) => f.origin === "user");
    expect(user.map((f) => f.displayPath)).toEqual([
      "~/.agents/AGENTS.md",
      "~/.claude/CLAUDE.md",
    ]);
    expect(user.map((f) => f.content)).toEqual(["agents rules", "claude rules"]);
  });

  it("tags the project chain and discovered dirs with their own origins", async () => {
    await fs.writeFile(path.join(project, "AGENTS.md"), "project rules");
    await fs.mkdir(path.join(project, "src"), { recursive: true });
    await fs.writeFile(path.join(project, "src", "AGENTS.md"), "src rules");
    const { collectInstructionFiles } = await import("../instructions.js");

    const loaded = await collectInstructionFiles(project, [path.join(project, "src")]);
    expect(loaded.find((f) => f.displayPath === "AGENTS.md")?.origin).toBe("project");
    expect(loaded.find((f) => f.displayPath === path.join("src", "AGENTS.md"))?.origin).toBe(
      "discovered",
    );
  });
});
