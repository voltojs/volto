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
    await fs.mkdir(path.join(home, ".volto", "skills"), { recursive: true });
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
    const skillDir = await writeSkill(path.join(home, ".volto", "skills"), "demo", "Body.");
    const { createSkillRegistry } = await import("../skills/registry.js");

    const loaded = await createSkillRegistry(cwd).load("demo");
    expect(loaded?.baseDir).toBe(skillDir);
    expect(loaded?.body).toBe("Body.");
  });

  it("returns undefined for an unknown skill", async () => {
    const { createSkillRegistry } = await import("../skills/registry.js");
    expect(await createSkillRegistry(cwd).load("nope")).toBeUndefined();
  });

  // Note on approach: the brief's original version of this test used
  // `vi.spyOn(fs, "readFile")` to assert the second list() call never reads
  // SKILL.md again. That throws under this repo's ESM setup ("Cannot spy on
  // export 'readFile'. Module namespace is not configurable in ESM.") before
  // the assertion even runs — the exact same limitation that made Task 4
  // abandon `vi.spyOn(os, "homedir")`. A spy that cannot attach would make
  // the test fail for the wrong reason (or, worse, pass vacuously if the API
  // shape ever changed), so this uses a behavioural check instead: write a
  // skill, list() it once to populate the cache, then rewrite the file with
  // different content but restore its original mtime (via fs.utimes) and
  // keep the byte length identical. A second list() call is only able to
  // return the stale (cached) description if it actually consulted the
  // cache instead of rereading — proving the cache is real with no mocking.
  it("reuses parsed metadata while mtime and size are unchanged", async () => {
    const dir = path.join(home, ".volto", "skills");
    const skillPath = path.join(await writeSkill(dir, "cached", "Body."), "SKILL.md");
    const { createSkillRegistry } = await import("../skills/registry.js");
    const registry = createSkillRegistry(cwd);

    // Pin mtime to a whole-second Unix timestamp before the first list().
    // fs.stat()'s natural mtimeMs carries sub-millisecond/nanosecond noise on
    // this filesystem (APFS), and round-tripping that through fs.utimes
    // (which only accepts Date or fractional-seconds numbers) does not
    // reproduce it bit-for-bit — verified empirically: both a Date
    // round-trip and a fractional-seconds round-trip landed a few
    // microseconds off the original. A whole-second timestamp has no
    // sub-second component to lose, so setting the exact same value twice
    // reproduces the exact same mtimeMs both times.
    const pinnedSeconds = Math.floor(Date.now() / 1000) - 60;
    await fs.utimes(skillPath, pinnedSeconds, pinnedSeconds);

    expect((await registry.list())[0]?.description).toBe("cached description");
    const originalStat = await fs.stat(skillPath);
    expect(originalStat.mtimeMs).toBe(pinnedSeconds * 1000);

    // Same byte length as "cached description" ("cached" and "edited" are
    // both 6 characters) so the cache key (path + mtime + size) is
    // unaffected by the content swap below.
    await fs.writeFile(
      skillPath,
      `---\nname: cached\ndescription: edited description\n---\nBody.`,
    );
    await fs.utimes(skillPath, pinnedSeconds, pinnedSeconds);
    const restoredStat = await fs.stat(skillPath);
    expect(restoredStat.size).toBe(originalStat.size);
    expect(restoredStat.mtimeMs).toBe(originalStat.mtimeMs);

    // The cache key (path + mtime + size) is unchanged, so a genuine cache
    // must still serve the original parsed metadata rather than rereading
    // the now-different bytes on disk.
    expect((await registry.list())[0]?.description).toBe("cached description");
  });

  it("re-parses after the file changes", async () => {
    const dir = path.join(home, ".volto", "skills");
    await writeSkill(dir, "changing", "Body.");
    const { createSkillRegistry } = await import("../skills/registry.js");
    const registry = createSkillRegistry(cwd);

    expect((await registry.list())[0]?.description).toBe("changing description");

    await fs.writeFile(
      path.join(dir, "changing", "SKILL.md"),
      `---\nname: changing\ndescription: updated description\n---\nBody.`,
    );
    expect((await registry.list())[0]?.description).toBe("updated description");
  });

  it("always rereads the body, never serving it from cache", async () => {
    const dir = path.join(home, ".volto", "skills");
    await writeSkill(dir, "live", "First body.");
    const { createSkillRegistry } = await import("../skills/registry.js");
    const registry = createSkillRegistry(cwd);

    expect((await registry.load("live"))?.body).toBe("First body.");
    await fs.writeFile(
      path.join(dir, "live", "SKILL.md"),
      `---\nname: live\ndescription: live description\n---\nSecond body.`,
    );
    expect((await registry.load("live"))?.body).toBe("Second body.");
  });

  // This is the scenario the finding above ("always rereads the body") does
  // not cover: there, both the byte length and mtime drift naturally, so the
  // *metadata* cache also misses on the second call — a future regression
  // that started serving `body` off the metadata-cache entry would still
  // pass. Here we pin mtime and keep the file's total byte length identical
  // (same technique as "reuses parsed metadata" above) so the metadata cache
  // genuinely HITS on the second load(), while only the body content
  // changes. If the body were ever served from that cache entry, this
  // assertion would see the stale body instead of the fresh one.
  it("serves the fresh body from disk even when the metadata cache hits", async () => {
    const dir = path.join(home, ".volto", "skills");
    const skillPath = path.join(await writeSkill(dir, "livecache", "First body."), "SKILL.md");
    const { createSkillRegistry } = await import("../skills/registry.js");
    const registry = createSkillRegistry(cwd);

    const pinnedSeconds = Math.floor(Date.now() / 1000) - 60;
    await fs.utimes(skillPath, pinnedSeconds, pinnedSeconds);

    expect((await registry.load("livecache"))?.body).toBe("First body.");
    const originalStat = await fs.stat(skillPath);
    expect(originalStat.mtimeMs).toBe(pinnedSeconds * 1000);

    // Same frontmatter, and a body of identical byte length ("First body."
    // and "Second body" are both 11 characters) so the cache key
    // (path + mtime + size) is unchanged — this must be a genuine
    // metadata-cache HIT, not a miss caused by a size/mtime change.
    await fs.writeFile(
      skillPath,
      `---\nname: livecache\ndescription: livecache description\n---\nSecond body`,
    );
    await fs.utimes(skillPath, pinnedSeconds, pinnedSeconds);
    const restoredStat = await fs.stat(skillPath);
    expect(restoredStat.size).toBe(originalStat.size);
    expect(restoredStat.mtimeMs).toBe(originalStat.mtimeMs);

    // The metadata cache hits (same key), but load() must still return the
    // NEW body — proving the body is never served from the cache entry.
    expect((await registry.load("livecache"))?.body).toBe("Second body");
  });

  describe("listSkillDefinitions", () => {
  it("tags each entry with scope, filePath, baseDir and shadowed=false", async () => {
    const userDir = path.join(home, ".volto", "skills");
    const projectDir = path.join(cwd, ".volto", "skills");
    await writeSkill(userDir, "u-skill", "U");
    await writeSkill(projectDir, "p-skill", "P");
    const { listSkillDefinitions } = await import("../skills/registry.js");

    const entries = await listSkillDefinitions(cwd);
    const user = entries.find((e) => e.name === "u-skill")!;
    expect(user.id).toBe("user:u-skill");
    expect(user.scope).toBe("user");
    expect(user.filePath).toBe(path.join(userDir, "u-skill", "SKILL.md"));
    expect(user.baseDir).toBe(path.join(userDir, "u-skill"));
    expect(user.shadowed).toBe(false);
    expect(entries.find((e) => e.name === "p-skill")?.scope).toBe("project");
  });

  it("keeps the losing same-named entry with shadowed=true", async () => {
    await writeSkill(path.join(home, ".volto", "skills"), "dup", "U");
    await writeSkill(path.join(cwd, ".volto", "skills"), "dup", "P");
    const { listSkillDefinitions } = await import("../skills/registry.js");

    const entries = await listSkillDefinitions(cwd);
    const dup = entries.filter((e) => e.name === "dup");
    expect(dup).toHaveLength(2);
    expect(dup.find((e) => e.scope === "project")?.shadowed).toBe(false);
    expect(dup.find((e) => e.scope === "user")?.shadowed).toBe(true);
  });

  it("sorts by scope then name regardless of readdir order", async () => {
    const userDir = path.join(home, ".volto", "skills");
    const projectDir = path.join(cwd, ".volto", "skills");
    await writeSkill(projectDir, "zeta", "Z");
    await writeSkill(userDir, "beta", "B");
    await writeSkill(userDir, "alpha", "A");
    await writeSkill(projectDir, "alpha", "PA");
    const { listSkillDefinitions } = await import("../skills/registry.js");

    const entries = await listSkillDefinitions(cwd);
    expect(entries.map((e) => `${e.scope}:${e.name}`)).toEqual([
      "user:alpha",
      "user:beta",
      "project:alpha",
      "project:zeta",
    ]);
  });
});
});
