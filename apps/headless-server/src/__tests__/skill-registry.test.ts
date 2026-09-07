import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

async function writeSkill(dir: string, name: string, body: string): Promise<string> {
  const skillDir = path.join(dir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n${body}`,
  );
  return skillDir;
}

describe("createSkillRegistry", () => {
  let base: string;
  let home: string;
  let cwd: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "volto-skills-"));
    home = path.join(base, "home");
    cwd = path.join(base, "project");
    await fs.mkdir(path.join(home, ".agents", "skills"), { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    // os.homedir() cannot be reliably spied under ESM in this repo — it
    // honors $HOME on POSIX, so redirect via the environment instead (same
    // pattern as wiring.test.ts / instructions.test.ts).
    originalHome = process.env["HOME"];
    process.env["HOME"] = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    await fs.rm(base, { recursive: true, force: true });
  });

  it("returns the skill directory as baseDir, not the SKILL.md path", async () => {
    const skillDir = await writeSkill(path.join(home, ".agents", "skills"), "demo", "Body.");
    const { createSkillRegistry } = await import("../skills/registry.js");

    const loaded = await createSkillRegistry(cwd).load("demo");
    expect(loaded?.baseDir).toBe(skillDir);
    expect(loaded?.body).toBe("Body.");
  });

  it("returns undefined for an unknown skill", async () => {
    const { createSkillRegistry } = await import("../skills/registry.js");
    expect(await createSkillRegistry(cwd).load("nope")).toBeUndefined();
  });
});
