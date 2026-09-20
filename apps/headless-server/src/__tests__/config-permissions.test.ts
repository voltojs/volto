import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadPermissionRules, mergePermissionRules, PermissionRulesConfigError } from "../config/permissions.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-perm-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(json: unknown): Promise<void> {
  await fs.writeFile(path.join(dir, "permissions.json"), JSON.stringify(json), "utf-8");
}

describe("loadPermissionRules", () => {
  it("returns an empty list when the file is absent", async () => {
    expect(await loadPermissionRules(dir)).toEqual([]);
  });

  it("loads a path rule and an ask host rule", async () => {
    await write({
      rules: [
        { pathPattern: "**/.env", decision: "ask" },
        { toolName: "write_file", pathPattern: "src/**", decision: "allow" },
        { hostPattern: "*.internal.example", decision: "ask" },
      ],
    });
    expect(await loadPermissionRules(dir)).toEqual([
      { pathPattern: "**/.env", decision: "ask" },
      { toolName: "write_file", pathPattern: "src/**", decision: "allow" },
      { hostPattern: "*.internal.example", decision: "ask" },
    ]);
  });

  it("expands ~ in a pathPattern to an absolute path", async () => {
    await write({ rules: [{ pathPattern: "~/.ssh/**", decision: "deny" }] });
    const [rule] = await loadPermissionRules(dir);
    expect(rule!.pathPattern).toBe(path.join(os.homedir(), ".ssh", "**"));
  });

  it("rejects an unknown key instead of ignoring it", async () => {
    await write({ rules: [{ pathPatern: "src/**", decision: "deny" }] });
    await expect(loadPermissionRules(dir)).rejects.toThrow(PermissionRulesConfigError);
  });

  it("rejects a top-level key other than rules", async () => {
    await write({ rules: [], rulez: [] });
    await expect(loadPermissionRules(dir)).rejects.toThrow(/unknown key/i);
  });

  it("rejects a rule with no match key", async () => {
    await write({ rules: [{ decision: "deny" }] });
    await expect(loadPermissionRules(dir)).rejects.toThrow(/match key/i);
  });

  it("rejects an invalid decision", async () => {
    await write({ rules: [{ pathPattern: "src/**", decision: "alloww" }] });
    await expect(loadPermissionRules(dir)).rejects.toThrow(/decision/i);
  });

  it("rejects a malformed file loudly rather than running without the policy", async () => {
    await fs.writeFile(path.join(dir, "permissions.json"), "{ not json", "utf-8");
    await expect(loadPermissionRules(dir)).rejects.toThrow(PermissionRulesConfigError);
  });
});

describe("mergePermissionRules", () => {
  it("puts user rules ahead of the preset's own rules (first match wins)", () => {
    const merged = mergePermissionRules(
      { sandbox: "workspace-write", approval: "ask", rules: [{ toolName: "bash", decision: "deny" }] },
      [{ pathPattern: "**/.env", decision: "ask" }],
    );
    expect(merged.rules).toEqual([
      { pathPattern: "**/.env", decision: "ask" },
      { toolName: "bash", decision: "deny" },
    ]);
  });

  it("returns the config untouched when there are no user rules", () => {
    const config = { sandbox: "workspace-write" as const, approval: "ask" as const };
    expect(mergePermissionRules(config, [])).toBe(config);
  });
});
