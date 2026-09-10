import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureConfigDir, getConfigDirRealPath } from "../config/paths.js";

let parent: string;

beforeEach(async () => {
  // mkdtemp itself creates with 0700, so exercise ensureConfigDir against a
  // path that does not exist yet — otherwise the mode assertion below would
  // be vacuous (it would pass even if ensureConfigDir dropped its `mode`).
  parent = await fs.mkdtemp(path.join(os.tmpdir(), "volto-paths-"));
});

afterEach(async () => {
  delete process.env["VOLTO_CONFIG_DIR"];
  await fs.rm(parent, { recursive: true, force: true });
});

describe("ensureConfigDir", () => {
  it("creates the config directory with 0700 permissions", async () => {
    const dir = path.join(parent, "volto-config");
    await ensureConfigDir(dir);
    const stat = await fs.stat(dir);
    expect(stat.mode & 0o777).toBe(0o700);
  });
});

describe("getConfigDirRealPath", () => {
  it("creates the config dir if needed and returns its realpath", async () => {
    // Deliberately a path under os.tmpdir(), which is itself a symlink on
    // macOS (/tmp -> /private/tmp) — the whole point of this helper is that
    // the sandbox compares real paths, so the returned value must be the
    // symlink-resolved form.
    const dir = path.join(parent, "volto-config");
    process.env["VOLTO_CONFIG_DIR"] = dir;

    const real = await getConfigDirRealPath();

    expect(real).toBe(await fs.realpath(dir));
    // The directory must exist after the call (it is created lazily).
    const stat = await fs.stat(real);
    expect(stat.isDirectory()).toBe(true);
  });
});
