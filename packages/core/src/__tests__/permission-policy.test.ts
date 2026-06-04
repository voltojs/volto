import { describe, it, expect } from "vitest";
import { evaluatePermission, createDefaultPermissionConfig } from "../permission-policy.js";
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
    // Unknown tier is not in the defaults, so it falls through to "ask"
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
