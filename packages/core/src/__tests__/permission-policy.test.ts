import { describe, it, expect } from "vitest";
import {
  evaluatePermission,
  resolvePermission,
  createDefaultPermissionConfig,
  ceilingOf,
  visibleRiskCeiling,
  decide,
  isWriteTier,
  policyDenialMessage,
  narrowPermission,
  hasParameterRules,
  hasCommandRules,
} from "../permission-policy.js";
import type { PermissionConfig, SandboxMode, ApprovalPolicy, Decision } from "../permission-policy.js";
import type { RiskTier } from "../tool.js";

const TIERS: RiskTier[] = ["READ_ONLY", "WRITE_LOW", "WRITE_HIGH", "IRREVERSIBLE"];

/** The four UI presets, as (sandbox, approval) pairs. */
const PRESETS: Record<string, { sandbox: SandboxMode; approval: ApprovalPolicy }> = {
  readOnly: { sandbox: "read-only", approval: "never" },
  ask: { sandbox: "workspace-write", approval: "ask" },
  auto: { sandbox: "workspace-write", approval: "never" },
  full: { sandbox: "danger-full-access", approval: "never" },
};

/** Design doc §3.2 — the authoritative 4x4 matrix, column by column. */
const EXPECTED: Record<keyof typeof PRESETS, Record<RiskTier, Decision>> = {
  readOnly: { READ_ONLY: "allow", WRITE_LOW: "deny", WRITE_HIGH: "deny", IRREVERSIBLE: "deny" },
  ask: { READ_ONLY: "allow", WRITE_LOW: "allow", WRITE_HIGH: "ask", IRREVERSIBLE: "ask" },
  auto: { READ_ONLY: "allow", WRITE_LOW: "allow", WRITE_HIGH: "allow", IRREVERSIBLE: "deny" },
  full: { READ_ONLY: "allow", WRITE_LOW: "allow", WRITE_HIGH: "allow", IRREVERSIBLE: "allow" },
};

describe("ceilingOf", () => {
  it("maps each sandbox mode to its highest permitted tier", () => {
    expect(ceilingOf("read-only")).toBe("READ_ONLY");
    expect(ceilingOf("workspace-write")).toBe("WRITE_HIGH");
    expect(ceilingOf("danger-full-access")).toBe("IRREVERSIBLE");
  });
});

describe("visibleRiskCeiling — the visible set can be wider than the sandbox ceiling", () => {
  it("keeps the sandbox ceiling for a never policy (read-only / auto / full)", () => {
    expect(visibleRiskCeiling({ sandbox: "read-only", approval: "never" })).toBe("READ_ONLY");
    expect(visibleRiskCeiling({ sandbox: "workspace-write", approval: "never" })).toBe("WRITE_HIGH");
    expect(visibleRiskCeiling({ sandbox: "danger-full-access", approval: "never" })).toBe("IRREVERSIBLE");
  });

  it("widens workspace-write + ask to IRREVERSIBLE so the prompt can fire", () => {
    // `decide` already answers "ask" for an above-ceiling IRREVERSIBLE call;
    // the visible set has to keep the tool or that branch is dead.
    expect(visibleRiskCeiling({ sandbox: "workspace-write", approval: "ask" })).toBe("IRREVERSIBLE");
    expect(decide("WRITE_HIGH", "ask", "IRREVERSIBLE")).toBe("ask");
  });

  it("does not widen read-only + ask: every write stays above that boundary", () => {
    expect(visibleRiskCeiling({ sandbox: "read-only", approval: "ask" })).toBe("READ_ONLY");
  });
});

describe("decide — the 4x4 matrix", () => {
  for (const [preset, knobs] of Object.entries(PRESETS)) {
    for (const tier of TIERS) {
      const expected = EXPECTED[preset as keyof typeof PRESETS]![tier];
      it(`${preset} (${knobs.sandbox} + ${knobs.approval}) / ${tier} -> ${expected}`, () => {
        expect(decide(ceilingOf(knobs.sandbox), knobs.approval, tier)).toBe(expected);
      });
    }
  }

  it("escalates above the ceiling to ask when the approval policy can ask", () => {
    // read-only + ask is a legal (if UI-unexposed) combination: nothing may be
    // written without the user saying so explicitly.
    expect(decide(ceilingOf("read-only"), "ask", "WRITE_LOW")).toBe("ask");
    expect(decide(ceilingOf("read-only"), "ask", "IRREVERSIBLE")).toBe("ask");
    expect(decide(ceilingOf("read-only"), "ask", "READ_ONLY")).toBe("allow");
  });

  it("never asks below WRITE_HIGH even under the ask policy", () => {
    expect(decide(ceilingOf("danger-full-access"), "ask", "READ_ONLY")).toBe("allow");
    expect(decide(ceilingOf("danger-full-access"), "ask", "WRITE_LOW")).toBe("allow");
    expect(decide(ceilingOf("danger-full-access"), "ask", "WRITE_HIGH")).toBe("ask");
  });
});

describe("evaluatePermission", () => {
  const askPreset: PermissionConfig = { sandbox: "workspace-write", approval: "ask" };

  it("falls through to the matrix when no rule matches", () => {
    expect(evaluatePermission(askPreset, "read_file", "READ_ONLY")).toBe("allow");
    expect(evaluatePermission(askPreset, "bash", "WRITE_HIGH")).toBe("ask");
  });

  it("lets an exact toolName rule outrank the matrix", () => {
    const config: PermissionConfig = {
      ...askPreset,
      rules: [{ toolName: "bash", decision: "allow" }],
    };
    expect(evaluatePermission(config, "bash", "WRITE_HIGH")).toBe("allow");
  });

  it("lets a rule tighten as well as loosen", () => {
    const config: PermissionConfig = {
      ...askPreset,
      rules: [{ toolName: "read_file", decision: "deny" }],
    };
    expect(evaluatePermission(config, "read_file", "READ_ONLY")).toBe("deny");
  });

  it("returns the first matching rule, not the most specific", () => {
    const config: PermissionConfig = {
      ...askPreset,
      rules: [
        { toolPattern: "db_*", decision: "deny" },
        { toolName: "db_query", decision: "allow" },
      ],
    };
    expect(evaluatePermission(config, "db_query", "READ_ONLY")).toBe("deny");
  });

  it("matches a rule by capability", () => {
    const config: PermissionConfig = {
      ...askPreset,
      rules: [{ capability: "shell:exec", decision: "deny" }],
    };
    expect(evaluatePermission(config, "bash", "WRITE_HIGH", new Set(["shell:exec"]))).toBe("deny");
    expect(evaluatePermission(config, "bash", "WRITE_HIGH", new Set(["filesystem:read"]))).toBe("ask");
  });

  it("ignores a capability rule when no capability set is supplied", () => {
    const config: PermissionConfig = {
      ...askPreset,
      rules: [{ capability: "shell:exec", decision: "deny" }],
    };
    expect(evaluatePermission(config, "bash", "WRITE_HIGH")).toBe("ask");
  });

  it("agrees with the matrix for every preset and tier", () => {
    for (const [preset, knobs] of Object.entries(PRESETS)) {
      for (const tier of TIERS) {
        expect(evaluatePermission(knobs, "any_tool", tier)).toBe(
          EXPECTED[preset as keyof typeof PRESETS]![tier],
        );
      }
    }
  });
});

describe("createDefaultPermissionConfig", () => {
  it("defaults to the ask preset", () => {
    expect(createDefaultPermissionConfig()).toEqual({
      sandbox: "workspace-write",
      approval: "ask",
    });
  });
});

describe("isWriteTier", () => {
  it("treats every non-READ_ONLY tier as a write tier", () => {
    expect(isWriteTier("READ_ONLY")).toBe(false);
    expect(isWriteTier("WRITE_LOW")).toBe(true);
    expect(isWriteTier("WRITE_HIGH")).toBe(true);
    expect(isWriteTier("IRREVERSIBLE")).toBe(true);
  });
});

describe("policyDenialMessage", () => {
  const autoConfig: PermissionConfig = { sandbox: "workspace-write", approval: "never" };

  it("names the tool and states the configured boundary", () => {
    const msg = policyDenialMessage("git_push", autoConfig);
    expect(msg).toContain('"git_push"');
    expect(msg).toContain("workspace-write");
    expect(msg).toContain("approval: never");
  });

  it("says this is a configured boundary, not a tool malfunction", () => {
    const msg = policyDenialMessage("git_push", autoConfig);
    expect(msg).toMatch(/not a failure of the tool/i);
  });

  it("forbids routing around it and names bash specifically", () => {
    const msg = policyDenialMessage("git_push", autoConfig);
    expect(msg).toMatch(/do not use `bash`/i);
  });

  it("forbids reaching the REFUSED effect another way, not switching tools at all", () => {
    // Read literally, "do not attempt the same effect through another tool"
    // banned the write_file -> edit_file fallback this docblock promises to
    // keep. The prohibition has to name the refused effect, and say so.
    const msg = policyDenialMessage("git_push", autoConfig);
    expect(msg).toMatch(/do not reach the refused effect through another tool/i);
    expect(msg).toMatch(/work that was not refused is ordinary tool selection/i);
  });

  it("gives a constructive exit instead of leaving the model stuck", () => {
    const msg = policyDenialMessage("git_push", autoConfig);
    expect(msg).toMatch(/tell the user/i);
    expect(msg).toMatch(/permission setting/i);
  });

  it("reflects the actual config rather than a fixed string", () => {
    const readOnly: PermissionConfig = { sandbox: "read-only", approval: "never" };
    expect(policyDenialMessage("write_file", readOnly)).toContain("read-only");
    expect(policyDenialMessage("write_file", readOnly)).not.toContain("workspace-write");
  });
});

describe("evaluatePermission — parameter rules", () => {
  const askPreset: PermissionConfig = { sandbox: "workspace-write", approval: "ask" };
  const envPaths = [{ field: "path", absolute: "/proj/src/.env", relative: "src/.env" }];
  const deepPath = [{ field: "path", absolute: "/proj/src/a/b.ts", relative: "src/a/b.ts" }];
  const internalHost = [{ field: "url", host: "db.internal.example" }];

  it("matches a pathPattern against both the absolute and the workspace-relative form", () => {
    const absolute: PermissionConfig = {
      ...askPreset,
      rules: [{ pathPattern: "**/src/**", decision: "deny" }],
    };
    expect(evaluatePermission(absolute, "read_file", "READ_ONLY", undefined, { paths: envPaths })).toBe("deny");

    const relative: PermissionConfig = {
      ...askPreset,
      rules: [{ pathPattern: "src/**", decision: "deny" }],
    };
    expect(evaluatePermission(relative, "read_file", "READ_ONLY", undefined, { paths: envPaths })).toBe("deny");
  });

  it("does not let * cross a path separator", () => {
    const config: PermissionConfig = {
      ...askPreset,
      rules: [{ pathPattern: "src/*.ts", decision: "deny" }],
    };
    expect(evaluatePermission(config, "read_file", "READ_ONLY", undefined, { paths: deepPath })).toBe("allow");
  });

  it("never matches a pathPattern when the tool declared no path facts", () => {
    const config: PermissionConfig = { ...askPreset, rules: [{ pathPattern: "**", decision: "deny" }] };
    expect(evaluatePermission(config, "bash", "WRITE_HIGH")).toBe("ask");
  });

  it("parameter-only pathPattern matches any tool whose resolved paths match", () => {
    const config: PermissionConfig = {
      ...askPreset,
      rules: [{ pathPattern: "**/src/**", decision: "deny" }],
    };
    // Any tool with a matching path → deny
    expect(evaluatePermission(config, "read_file", "READ_ONLY", undefined, { paths: envPaths })).toBe("deny");
    expect(evaluatePermission(config, "unknown_tool", "WRITE_LOW", undefined, { paths: envPaths })).toBe("deny");
    // Same tool, no resolved facts → rule doesn't match → matrix result
    expect(evaluatePermission(config, "read_file", "READ_ONLY")).toBe("allow");
    expect(evaluatePermission(config, "unknown_tool", "WRITE_LOW")).toBe("allow");
  });

  it("never matches a hostPattern when the tool declared no host facts", () => {
    const config: PermissionConfig = { ...askPreset, rules: [{ hostPattern: "**", decision: "deny" }] };
    // No resolved → rule doesn't match → falls to matrix → WRITE_HIGH under ask → "ask"
    expect(evaluatePermission(config, "web_fetch", "WRITE_HIGH")).toBe("ask");
    // Even with paths but no hosts → still doesn't match
    expect(
      evaluatePermission(config, "web_fetch", "WRITE_HIGH", undefined, { paths: envPaths }),
    ).toBe("ask");
  });

  it("requires the tool key group and the parameter key group to both match", () => {
    const config: PermissionConfig = {
      ...askPreset,
      rules: [{ toolName: "read_file", pathPattern: "**/.env", decision: "deny" }],
    };
    expect(evaluatePermission(config, "read_file", "READ_ONLY", undefined, { paths: envPaths })).toBe("deny");
    expect(evaluatePermission(config, "write_file", "WRITE_HIGH", undefined, { paths: envPaths })).toBe("ask");
  });

  it("treats a rule with no match key as inert", () => {
    const config: PermissionConfig = { ...askPreset, rules: [{ decision: "deny" }] };
    expect(evaluatePermission(config, "read_file", "READ_ONLY")).toBe("allow");
  });

  it("clamps an allow rule that would cross the sandbox ceiling", () => {
    const config: PermissionConfig = {
      sandbox: "read-only",
      approval: "never",
      rules: [{ toolName: "write_file", decision: "allow" }],
    };
    expect(evaluatePermission(config, "write_file", "WRITE_HIGH")).toBe("deny");
  });

  it("clamps an allow rule to ask above the ceiling instead of granting it", () => {
    const config: PermissionConfig = {
      sandbox: "workspace-write",
      approval: "ask",
      rules: [{ toolName: "git_push", decision: "allow" }],
    };
    expect(evaluatePermission(config, "git_push", "IRREVERSIBLE")).toBe("ask");
  });

  it("clamps an ask rule to deny above the ceiling under the never policy", () => {
    const config: PermissionConfig = {
      sandbox: "workspace-write",
      approval: "never",
      rules: [{ toolName: "git_push", decision: "ask" }],
    };
    expect(evaluatePermission(config, "git_push", "IRREVERSIBLE")).toBe("deny");
  });

  it("still lets an allow rule reduce prompts below the ceiling", () => {
    const config: PermissionConfig = { ...askPreset, rules: [{ toolName: "bash", decision: "allow" }] };
    expect(evaluatePermission(config, "bash", "WRITE_HIGH")).toBe("allow");
  });

  it("matches a hostPattern only when the host is exactly what the glob describes", () => {
    const config: PermissionConfig = {
      ...askPreset,
      rules: [{ hostPattern: "*.internal.example", decision: "ask" }],
    };
    expect(evaluatePermission(config, "web_fetch", "READ_ONLY", undefined, { hosts: internalHost })).toBe("ask");
    expect(
      evaluatePermission(config, "web_fetch", "READ_ONLY", undefined, {
        hosts: [{ field: "url", host: "internal.example" }],
      }),
    ).toBe("allow");
  });

  it("reports whether the Runner must resolve parameter facts", () => {
    expect(hasParameterRules(askPreset)).toBe(false);
    expect(hasParameterRules({ ...askPreset, rules: [{ toolName: "bash", decision: "ask" }] })).toBe(false);
    expect(hasParameterRules({ ...askPreset, rules: [{ pathPattern: "src/**", decision: "ask" }] })).toBe(true);
    expect(hasParameterRules({ ...askPreset, rules: [{ hostPattern: "x.example", decision: "ask" }] })).toBe(true);
  });
});

describe("narrowPermission — parameter rules", () => {
  const parent: PermissionConfig = {
    sandbox: "workspace-write",
    approval: "ask",
    rules: [
      { pathPattern: "**/.env", decision: "deny" },
      { pathPattern: "src/**", decision: "allow" },
    ],
  };

  it("keeps the parent's tightening rules so a child cannot read a denied path", () => {
    const child = narrowPermission(parent, { sandbox: "workspace-write", approval: "ask" });
    expect(child.rules).toEqual([{ pathPattern: "**/.env", decision: "deny" }]);
  });

  it("drops a child's own allow rule", () => {
    const child = narrowPermission(parent, {
      sandbox: "workspace-write",
      approval: "ask",
      rules: [{ pathPattern: "**", decision: "allow" }],
    });
    expect(child.rules).toEqual([{ pathPattern: "**/.env", decision: "deny" }]);
  });

  it("drops a commandPrefix allow rule when narrowing", () => {
    const child = narrowPermission(
      {
        sandbox: "workspace-write",
        approval: "ask",
        rules: [{ toolName: "bash", commandPrefix: ["pnpm", "test"], decision: "allow" }],
      },
      { sandbox: "read-only", approval: "never" },
    );
    expect(child.rules ?? []).toEqual([]);
  });
});

describe("evaluatePermission — command prefix rules", () => {
  const askPreset: PermissionConfig = { sandbox: "workspace-write", approval: "ask" };
  const allowTest: PermissionConfig = {
    ...askPreset,
    rules: [{ toolName: "bash", commandPrefix: ["pnpm", "test"], decision: "allow" }],
  };

  it("turns ask into allow for a matching single command", () => {
    expect(evaluatePermission(allowTest, "bash", "WRITE_HIGH", undefined, undefined, ["pnpm test"])).toBe("allow");
    expect(
      evaluatePermission(allowTest, "bash", "WRITE_HIGH", undefined, undefined, ["pnpm test --filter x"]),
    ).toBe("allow");
  });

  it("stays ask for a compound command, an assignment, or a near miss", () => {
    for (const command of [
      "pnpm test; rm -rf ~",
      "pnpm test && rm -rf ~",
      "FOO=1 pnpm test",
      "pnpm test2",
    ]) {
      expect(evaluatePermission(allowTest, "bash", "WRITE_HIGH", undefined, undefined, [command])).toBe("ask");
    }
  });

  it("never matches when the caller supplied no command values", () => {
    // The Runner supplies values only for tools that declare `commandInputs`,
    // so a tool that declares none can never reach the command branch. This
    // pins the core side of that contract.
    expect(evaluatePermission(allowTest, "bash", "WRITE_HIGH")).toBe("ask");
  });

  it("cannot widen past the sandbox ceiling even with a matching command", () => {
    const readOnly: PermissionConfig = {
      sandbox: "read-only",
      approval: "never",
      rules: [{ toolName: "bash", commandPrefix: ["pnpm", "test"], decision: "allow" }],
    };
    expect(evaluatePermission(readOnly, "bash", "WRITE_HIGH", undefined, undefined, ["pnpm test"])).toBe("deny");
  });

  it("matches a commandPrefix-only rule (no tool key) when a matching command is supplied", () => {
    // Core is shape-agnostic: it does NOT enforce the "must name the tool" constraint.
    // That is the config loaders' duty (Tasks 6/7 reject a rule that carries commandPrefix
    // but no toolName/toolPattern/capability). This test pins that split so nobody later
    // "fixes" core and quietly removes the reason the loaders exist.
    const prefixOnly: PermissionConfig = {
      ...askPreset,
      rules: [{ commandPrefix: ["pnpm", "test"], decision: "allow" }],
    };
    // Matching command supplied → rule matches → allow
    expect(evaluatePermission(prefixOnly, "bash", "WRITE_HIGH", undefined, undefined, ["pnpm test"])).toBe("allow");
    // No command supplied → rule does not match → falls to matrix → ask
    expect(evaluatePermission(prefixOnly, "bash", "WRITE_HIGH")).toBe("ask");
  });

  it("requires the tool key group as well as the command group", () => {
    const otherTool: PermissionConfig = {
      ...askPreset,
      rules: [{ toolName: "other_exec", commandPrefix: ["pnpm", "test"], decision: "allow" }],
    };
    expect(evaluatePermission(otherTool, "bash", "WRITE_HIGH", undefined, undefined, ["pnpm test"])).toBe("ask");
  });

  it("reports which rule produced the decision", () => {
    const resolution = resolvePermission(allowTest, "bash", "WRITE_HIGH", undefined, undefined, ["pnpm test"]);
    expect(resolution.decision).toBe("allow");
    expect(resolution.rule).toEqual({ toolName: "bash", commandPrefix: ["pnpm", "test"], decision: "allow" });

    const matrix = resolvePermission(askPreset, "bash", "WRITE_HIGH");
    expect(matrix.decision).toBe("ask");
    expect(matrix.rule).toBeUndefined();
  });

  it("reports whether the Runner must collect command values", () => {
    expect(hasCommandRules(askPreset)).toBe(false);
    expect(hasCommandRules({ ...askPreset, rules: [{ toolName: "bash", decision: "allow" }] })).toBe(false);
    expect(hasCommandRules(allowTest)).toBe(true);
  });
});
