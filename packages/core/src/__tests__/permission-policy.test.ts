import { describe, it, expect } from "vitest";
import {
  evaluatePermission,
  createDefaultPermissionConfig,
  ceilingOf,
  decide,
  isWriteTier,
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
