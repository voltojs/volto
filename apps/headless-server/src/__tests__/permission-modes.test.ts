import { describe, it, expect } from "vitest";
import { buildPermissionConfig, isUiPermissionMode } from "../permission-modes.js";

describe("buildPermissionConfig", () => {
  it("uses core's plan mode for the planning tier", () => {
    const config = buildPermissionConfig("plan");
    expect(config.mode).toBe("plan");
    expect(config.defaults.READ_ONLY).toBe("allow");
    expect(config.defaults.WRITE_HIGH).toBe("deny");
  });

  it("allows writes but denies irreversible operations on auto-accept", () => {
    const config = buildPermissionConfig("auto-accept");
    expect(config.defaults.READ_ONLY).toBe("allow");
    expect(config.defaults.WRITE_LOW).toBe("allow");
    expect(config.defaults.WRITE_HIGH).toBe("allow");
    expect(config.defaults.IRREVERSIBLE).toBe("deny");
  });

  it("omits mode on auto-accept so IRREVERSIBLE is never downgraded to ask", () => {
    // core's "auto-accept" mode maps IRREVERSIBLE to "ask", and the gateway's
    // auto-allow gate would then wave it through silently. Setting mode here
    // would silently defeat the deny above.
    expect(buildPermissionConfig("auto-accept").mode).toBeUndefined();
  });

  it("recognises only the two supported modes", () => {
    expect(isUiPermissionMode("plan")).toBe(true);
    expect(isUiPermissionMode("auto-accept")).toBe(true);
    expect(isUiPermissionMode("default")).toBe(false);
    expect(isUiPermissionMode(undefined)).toBe(false);
  });
});
