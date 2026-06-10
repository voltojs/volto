import { describe, it, expect } from "vitest";
import {
  evaluatePermission,
  createDefaultPermissionConfig,
  isWriteTier,
} from "../permission-policy.js";
import type { PermissionConfig } from "../permission-policy.js";
import type { RiskTier } from "../tool.js";

describe("evaluatePermission", () => {
  const config: PermissionConfig = {
    defaults: {
      READ_ONLY: "allow",
      WRITE_LOW: "allow",
      WRITE_HIGH: "ask",
      IRREVERSIBLE: "deny",
    },
  };

  it("allows READ_ONLY tools by default", () => {
    expect(evaluatePermission(config, "read_file", "READ_ONLY")).toBe("allow");
  });

  it("allows WRITE_LOW tools by default", () => {
    expect(evaluatePermission(config, "edit_file", "WRITE_LOW")).toBe("allow");
  });

  it("asks for WRITE_HIGH tools by default", () => {
    expect(evaluatePermission(config, "bash", "WRITE_HIGH")).toBe("ask");
  });

  it("denies IRREVERSIBLE tools by default", () => {
    expect(evaluatePermission(config, "rm_rf", "IRREVERSIBLE")).toBe("deny");
  });

  it("uses tool override over tier default", () => {
    const withOverride: PermissionConfig = {
      defaults: config.defaults,
      toolOverrides: { read_file: "deny" },
    };
    expect(evaluatePermission(withOverride, "read_file", "READ_ONLY")).toBe("deny");
  });

  it("falls back to tier default when no tool override", () => {
    const withOverride: PermissionConfig = {
      defaults: config.defaults,
      toolOverrides: { other_tool: "deny" },
    };
    expect(evaluatePermission(withOverride, "read_file", "READ_ONLY")).toBe("allow");
  });

  it("returns ask for unknown risk tier", () => {
    const unknownTierConfig: PermissionConfig = {
      defaults: {
        READ_ONLY: "allow",
        WRITE_LOW: "allow",
        WRITE_HIGH: "ask",
        IRREVERSIBLE: "deny",
      },
    };
    expect(evaluatePermission(unknownTierConfig, "tool", "UNKNOWN_TIER" as RiskTier)).toBe("ask");
  });

  it("handles config with no tool overrides", () => {
    expect(evaluatePermission(config, "any_tool", "WRITE_HIGH")).toBe("ask");
  });
});

describe("createDefaultPermissionConfig", () => {
  it("creates config with sensible defaults", () => {
    const config = createDefaultPermissionConfig();
    expect(config.defaults.READ_ONLY).toBe("allow");
    expect(config.defaults.WRITE_LOW).toBe("allow");
    expect(config.defaults.WRITE_HIGH).toBe("ask");
    expect(config.defaults.IRREVERSIBLE).toBe("deny");
  });

  it("applies tool overrides when provided", () => {
    const config = createDefaultPermissionConfig({ bash: "deny" });
    expect(config.toolOverrides?.bash).toBe("deny");
    expect(evaluatePermission(config, "bash", "WRITE_HIGH")).toBe("deny");
  });

  it("has no tool overrides by default", () => {
    const config = createDefaultPermissionConfig();
    expect(config.toolOverrides).toBeUndefined();
  });
});

describe("isWriteTier", () => {
  it("returns false for READ_ONLY", () => {
    expect(isWriteTier("READ_ONLY")).toBe(false);
  });

  it("returns true for WRITE_LOW", () => {
    expect(isWriteTier("WRITE_LOW")).toBe(true);
  });

  it("returns true for WRITE_HIGH", () => {
    expect(isWriteTier("WRITE_HIGH")).toBe(true);
  });

  it("returns true for IRREVERSIBLE", () => {
    expect(isWriteTier("IRREVERSIBLE")).toBe(true);
  });
});

describe("evaluatePermission — permission modes", () => {
  const config: PermissionConfig = {
    defaults: {
      READ_ONLY: "allow",
      WRITE_LOW: "allow",
      WRITE_HIGH: "ask",
      IRREVERSIBLE: "deny",
    },
  };

  describe("plan mode", () => {
    const planConfig: PermissionConfig = { ...config, mode: "plan" };

    it("allows READ_ONLY tools", () => {
      expect(evaluatePermission(planConfig, "read_file", "READ_ONLY")).toBe("allow");
    });

    it("denies WRITE_LOW tools", () => {
      expect(evaluatePermission(planConfig, "edit_file", "WRITE_LOW")).toBe("deny");
    });

    it("denies WRITE_HIGH tools", () => {
      expect(evaluatePermission(planConfig, "bash", "WRITE_HIGH")).toBe("deny");
    });

    it("denies IRREVERSIBLE tools", () => {
      expect(evaluatePermission(planConfig, "rm_rf", "IRREVERSIBLE")).toBe("deny");
    });
  });

  describe("auto-accept mode", () => {
    const autoConfig: PermissionConfig = { ...config, mode: "auto-accept" };

    it("allows READ_ONLY tools", () => {
      expect(evaluatePermission(autoConfig, "read_file", "READ_ONLY")).toBe("allow");
    });

    it("allows WRITE_LOW tools", () => {
      expect(evaluatePermission(autoConfig, "edit_file", "WRITE_LOW")).toBe("allow");
    });

    it("allows WRITE_HIGH tools", () => {
      expect(evaluatePermission(autoConfig, "bash", "WRITE_HIGH")).toBe("allow");
    });

    it("asks for IRREVERSIBLE tools", () => {
      expect(evaluatePermission(autoConfig, "rm_rf", "IRREVERSIBLE")).toBe("ask");
    });
  });

  describe("default mode (no mode)", () => {
    it("maintains existing behavior (no mode = default)", () => {
      expect(evaluatePermission(config, "read_file", "READ_ONLY")).toBe("allow");
      expect(evaluatePermission(config, "bash", "WRITE_HIGH")).toBe("ask");
    });
  });
});

describe("evaluatePermission — rule set priority", () => {
  const config: PermissionConfig = {
    defaults: {
      READ_ONLY: "allow",
      WRITE_LOW: "allow",
      WRITE_HIGH: "ask",
      IRREVERSIBLE: "deny",
    },
  };

  it("rules override mode decisions", () => {
    const planConfigWithRules: PermissionConfig = {
      ...config,
      mode: "plan",
      rules: [
        { toolName: "bash", decision: "allow" },
      ],
    };
    expect(evaluatePermission(planConfigWithRules, "bash", "WRITE_HIGH")).toBe("allow");
  });

  it("rules override toolOverrides", () => {
    const configWithOverrideAndRule: PermissionConfig = {
      ...config,
      toolOverrides: { edit_file: "deny" },
      rules: [
        { toolName: "edit_file", decision: "allow" },
      ],
    };
    expect(evaluatePermission(configWithOverrideAndRule, "edit_file", "WRITE_LOW")).toBe("allow");
  });

  it("toolPattern glob match", () => {
    const configWithPattern: PermissionConfig = {
      ...config,
      rules: [
        { toolPattern: "db_*", decision: "ask" },
      ],
    };
    expect(evaluatePermission(configWithPattern, "db_query", "READ_ONLY")).toBe("ask");
    expect(evaluatePermission(configWithPattern, "db_exec", "WRITE_HIGH")).toBe("ask");
    expect(evaluatePermission(configWithPattern, "read_file", "READ_ONLY")).toBe("allow");
  });

  it("capability match", () => {
    const configWithCapRule: PermissionConfig = {
      ...config,
      rules: [
        { capability: "shell:exec", decision: "deny" },
      ],
    };
    expect(
      evaluatePermission(
        configWithCapRule,
        "bash",
        "WRITE_HIGH",
        new Set(["shell:exec"]),
      ),
    ).toBe("deny");
    expect(
      evaluatePermission(
        configWithCapRule,
        "edit_file",
        "WRITE_LOW",
        new Set(["filesystem:write"]),
      ),
    ).toBe("allow");
  });

  it("first matching rule wins", () => {
    const configMultiRules: PermissionConfig = {
      ...config,
      rules: [
        { toolName: "bash", decision: "deny" },
        { toolName: "bash", decision: "allow" },
      ],
    };
    expect(evaluatePermission(configMultiRules, "bash", "WRITE_HIGH")).toBe("deny");
  });

  it("mode decides when no rule matches", () => {
    const planConfig: PermissionConfig = {
      ...config,
      mode: "plan",
      rules: [
        { toolName: "bash", decision: "allow" },
      ],
    };
    expect(evaluatePermission(planConfig, "edit_file", "WRITE_LOW")).toBe("deny");
    expect(evaluatePermission(planConfig, "bash", "WRITE_HIGH")).toBe("allow");
  });
});
