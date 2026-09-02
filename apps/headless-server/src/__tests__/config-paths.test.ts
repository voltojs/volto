import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureConfigDir } from "../config/paths.js";

let parent: string;

beforeEach(async () => {
  // mkdtemp itself creates with 0700, so exercise ensureConfigDir against a
  // path that does not exist yet — otherwise the mode assertion below would
  // be vacuous (it would pass even if ensureConfigDir dropped its `mode`).
  parent = await fs.mkdtemp(path.join(os.tmpdir(), "volto-paths-"));
});

afterEach(async () => {
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
