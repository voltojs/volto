import { describe, it, expect } from "vitest";
import { permissionFingerprint, buildPermissionReminder } from "../permission-prompt.js";
import type { PermissionConfig } from "../permission-policy.js";

const ask: PermissionConfig = { sandbox: "workspace-write", approval: "ask" };
const auto: PermissionConfig = { sandbox: "workspace-write", approval: "never" };
const readOnly: PermissionConfig = { sandbox: "read-only", approval: "never" };

describe("permissionFingerprint", () => {
  it("is stable for the same config", () => {
    expect(permissionFingerprint(ask)).toBe(permissionFingerprint({ ...ask }));
  });

  it("changes when approval changes", () => {
    expect(permissionFingerprint(ask)).not.toBe(permissionFingerprint(auto));
  });

  it("changes when sandbox changes", () => {
    expect(permissionFingerprint(auto)).not.toBe(permissionFingerprint(readOnly));
  });

  it("changes when rules change", () => {
    const withRule: PermissionConfig = { ...ask, rules: [{ toolName: "bash", decision: "allow" }] };
    expect(permissionFingerprint(ask)).not.toBe(permissionFingerprint(withRule));
  });
});

describe("buildPermissionReminder", () => {
  it("wraps the content in a system-reminder envelope", () => {
    const text = buildPermissionReminder(ask);
    expect(text.startsWith("<system-reminder>")).toBe(true);
    expect(text.trimEnd().endsWith("</system-reminder>")).toBe(true);
  });

  it("never leaks host preset names", () => {
    for (const config of [ask, auto, readOnly]) {
      const text = buildPermissionReminder(config);
      for (const preset of ["read-only mode", "ask mode", "auto mode", "full mode"]) {
        expect(text).not.toContain(preset);
      }
    }
  });

  it("says writes are confined under workspace-write", () => {
    expect(buildPermissionReminder(ask)).toMatch(/confined to the workspace/i);
  });

  it("says nothing may be written under read-only", () => {
    expect(buildPermissionReminder(readOnly)).toMatch(/cannot write/i);
  });

  it("announces that high-risk calls stop to ask when approval is ask", () => {
    expect(buildPermissionReminder(ask)).toMatch(/stop and ask you/i);
  });

  it("announces that nothing stops to ask when approval is never", () => {
    expect(buildPermissionReminder(auto)).toMatch(/will not stop to ask/i);
  });

  it("warns that irreversible work is refused outright under auto", () => {
    expect(buildPermissionReminder(auto)).toMatch(/refused outright/i);
  });

  it("carries the no-routing-around rule in every config", () => {
    for (const config of [ask, auto, readOnly]) {
      expect(buildPermissionReminder(config)).toMatch(/do not use `bash`/i);
    }
  });

  it("frames a change as a change when a previous config is given", () => {
    const text = buildPermissionReminder(auto, ask);
    expect(text).toMatch(/changed/i);
  });

  it("does not frame the first announcement as a change", () => {
    expect(buildPermissionReminder(ask)).not.toMatch(/changed/i);
  });
});
