import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadPermissionRules,
  mergePermissionRules,
  savePermissionRule,
  PermissionRulesConfigError,
} from "../config/permissions.js";
import { getConfigStore } from "../config/store.js";

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

  it("rejects a valid rule that also carries an unknown key", async () => {
    await write({ rules: [{ pathPattern: "src/**", decision: "deny", foo: "bar" }] });
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

  it("rejects more than 100 rules", async () => {
    const rules = Array.from({ length: 101 }, (_, i) => ({
      pathPattern: `file-${i}.txt`,
      decision: "allow" as const,
    }));
    await write({ rules });
    await expect(loadPermissionRules(dir)).rejects.toThrow(PermissionRulesConfigError);
  });

  it("accepts exactly 100 rules", async () => {
    const rules = Array.from({ length: 100 }, (_, i) => ({
      pathPattern: `file-${i}.txt`,
      decision: "allow" as const,
    }));
    await write({ rules });
    const loaded = await loadPermissionRules(dir);
    expect(loaded).toHaveLength(100);
  });

  it("rejects rules when the value is not an array", async () => {
    await write({ rules: "not-an-array" });
    await expect(loadPermissionRules(dir)).rejects.toThrow(PermissionRulesConfigError);
  });

  it("rejects a non-object entry inside rules", async () => {
    await write({ rules: ["bad"] });
    await expect(loadPermissionRules(dir)).rejects.toThrow(PermissionRulesConfigError);
  });
});

describe("loadPermissionRules — command rules", () => {
  it("loads an allow command rule", async () => {
    await write({ rules: [{ toolName: "bash", commandPrefix: ["pnpm", "test"], decision: "allow" }] });
    expect(await loadPermissionRules(dir)).toEqual([
      { toolName: "bash", commandPrefix: ["pnpm", "test"], decision: "allow" },
    ]);
  });

  it("rejects a deny or ask command rule", async () => {
    for (const decision of ["deny", "ask"]) {
      await write({ rules: [{ toolName: "bash", commandPrefix: ["rm"], decision }] });
      await expect(loadPermissionRules(dir)).rejects.toThrow(/allow-only/i);
    }
  });

  it("rejects a command rule with no tool key", async () => {
    await write({ rules: [{ commandPrefix: ["pnpm", "test"], decision: "allow" }] });
    await expect(loadPermissionRules(dir)).rejects.toThrow(/toolName or toolPattern/i);
  });

  it("rejects an empty commandPrefix array", async () => {
    await write({ rules: [{ toolName: "bash", commandPrefix: [], decision: "allow" }] });
    await expect(loadPermissionRules(dir)).rejects.toThrow(/non-empty array/i);
  });

  it("rejects non-string, blank and over-long token lists", async () => {
    await write({ rules: [{ toolName: "bash", commandPrefix: ["pnpm", 1], decision: "allow" }] });
    await expect(loadPermissionRules(dir)).rejects.toThrow(/non-empty strings/i);

    await write({ rules: [{ toolName: "bash", commandPrefix: ["pnpm", " "], decision: "allow" }] });
    await expect(loadPermissionRules(dir)).rejects.toThrow(/non-empty strings/i);

    await write({ rules: [{ toolName: "bash", commandPrefix: ["a", "b", "c", "d", "e", "f", "g", "h", "i"], decision: "allow" }] });
    await expect(loadPermissionRules(dir)).rejects.toThrow(/at most 8/i);
  });

  it("rejects a token that could never match a command", async () => {
    for (const token of ["test*", "a|b", "~"]) {
      await write({ rules: [{ toolName: "bash", commandPrefix: ["pnpm", token], decision: "allow" }] });
      await expect(loadPermissionRules(dir)).rejects.toThrow(/without whitespace or shell metacharacters/i);
    }
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

describe("savePermissionRule", () => {
  const candidate = { toolName: "bash", commandPrefix: ["pnpm", "test"], decision: "allow" };

  it("appends a new rule without disturbing the existing ones", async () => {
    await write({ rules: [{ toolName: "bash", commandPrefix: ["git", "status"], decision: "allow" }] });
    const result = await savePermissionRule(dir, candidate);
    expect(result).toEqual({ status: "saved", rule: candidate });
    expect(await loadPermissionRules(dir)).toEqual([
      { toolName: "bash", commandPrefix: ["git", "status"], decision: "allow" },
      candidate,
    ]);
  });

  it("creates the file when it does not exist yet", async () => {
    const result = await savePermissionRule(dir, candidate);
    expect(result.status).toBe("saved");
    expect(await loadPermissionRules(dir)).toEqual([candidate]);
  });

  it("reports an identical rule as a duplicate instead of writing it twice", async () => {
    await write({ rules: [candidate] });
    expect(await savePermissionRule(dir, candidate)).toEqual({ status: "duplicate", rule: candidate });
    expect(await loadPermissionRules(dir)).toHaveLength(1);
  });

  it("reports a rule already covered by a broader prefix", async () => {
    await write({ rules: [candidate] });
    const narrower = { toolName: "bash", commandPrefix: ["pnpm", "test", "--filter", "x"], decision: "allow" };
    expect(await savePermissionRule(dir, narrower)).toEqual({ status: "covered", by: candidate });
    expect(await loadPermissionRules(dir)).toHaveLength(1);
  });

  it("does not treat a different tool or a narrower existing rule as coverage", async () => {
    await write({ rules: [{ toolName: "bash", commandPrefix: ["pnpm", "test", "extra"], decision: "allow" }] });
    expect((await savePermissionRule(dir, candidate)).status).toBe("saved");
    await getConfigStore(dir).update("permissions", () => ({
      rules: [{ toolName: "other", commandPrefix: ["pnpm"], decision: "allow" }],
    }));
    expect((await savePermissionRule(dir, candidate)).status).toBe("saved");
  });

  it("rejects a candidate the loader would reject", async () => {
    await expect(savePermissionRule(dir, { toolName: "bash", commandPrefix: [], decision: "allow" })).rejects.toThrow(
      PermissionRulesConfigError,
    );
    await expect(savePermissionRule(dir, { commandPrefix: ["pnpm"], decision: "allow" })).rejects.toThrow(
      /toolName or toolPattern/,
    );
    await expect(
      savePermissionRule(dir, { toolName: "bash", commandPrefix: ["pnpm"], decision: "deny" }),
    ).rejects.toThrow(/allow-only/);
  });

  it("refuses to overwrite a corrupt file", async () => {
    await fs.writeFile(path.join(dir, "permissions.json"), "{ not json", "utf-8");
    await expect(savePermissionRule(dir, candidate)).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, "permissions.json"), "utf-8")).toBe("{ not json");
  });

  it("serialises concurrent saves so neither is lost", async () => {
    const a = { toolName: "bash", commandPrefix: ["a"], decision: "allow" };
    const b = { toolName: "bash", commandPrefix: ["b"], decision: "allow" };
    await Promise.all([savePermissionRule(dir, a), savePermissionRule(dir, b)]);
    expect(await loadPermissionRules(dir)).toHaveLength(2);
  });

  it("does not report a pattern-only candidate as covered or duplicate", async () => {
    // A candidate with only toolPattern (no toolName) must not match the
    // existing rule's toolName via toolKeyMatches — the guard returns false.
    await write({ rules: [{ toolName: "bash", commandPrefix: ["pnpm", "test"], decision: "allow" }] });
    const patternCandidate = { toolPattern: "bash*", commandPrefix: ["pnpm", "test"], decision: "allow" };
    expect((await savePermissionRule(dir, patternCandidate)).status).toBe("saved");
  });
});
