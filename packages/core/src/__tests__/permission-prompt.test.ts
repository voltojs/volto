import { describe, it, expect } from "vitest";
import { permissionFingerprint, buildPermissionReminder } from "../permission-prompt.js";
import type { PermissionConfig } from "../permission-policy.js";
import { ceilingOf, decide } from "../permission-policy.js";

const ask: PermissionConfig = { sandbox: "workspace-write", approval: "ask" };
const auto: PermissionConfig = { sandbox: "workspace-write", approval: "never" };
const readOnly: PermissionConfig = { sandbox: "read-only", approval: "never" };
/**
 * The sixth (sandbox x approval) combination. Unreachable through the four
 * host presets, reachable through the SDK's public `permissionConfig`. The
 * matrix still says "ask" for a write above the READ_ONLY ceiling, but with
 * the risk ceiling wired into the visible set the write tool is pruned
 * before any decision can escalate — the one cell where the old escalation
 * wording had to give way to removal wording.
 */
const readOnlyAsk: PermissionConfig = { sandbox: "read-only", approval: "ask" };
const full: PermissionConfig = { sandbox: "danger-full-access", approval: "never" };
const fullAsk: PermissionConfig = { sandbox: "danger-full-access", approval: "ask" };
const allConfigs = [ask, auto, readOnly, readOnlyAsk, full, fullAsk];

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
    for (const config of allConfigs) {
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
    expect(buildPermissionReminder(readOnly)).toMatch(/every write is refused/i);
  });

  it("says write tools were removed from the available list under read-only + ask", () => {
    // The matrix still says "ask" for a write above the READ_ONLY ceiling,
    // but the risk ceiling is wired into the visible set: the write tool is
    // pruned before any decision can escalate it. An approval prompt needs a
    // visible tool to trigger on, so the old "put to the user for approval"
    // described a path that no longer exists — and "every write is refused"
    // would contradict the matrix, which still says "ask".
    expect(decide("READ_ONLY", "ask", "WRITE_LOW")).toBe("ask");
    const text = buildPermissionReminder(readOnlyAsk);
    expect(text).not.toMatch(/every write is refused/i);
    expect(text).not.toMatch(/put to the user for approval/i);
    expect(text).toMatch(/cannot write to the filesystem/i);
    expect(text).toMatch(/removed from your available tool list/i);
  });

  it("never says a tier is refused when the matrix would escalate it", () => {
    // The whole-file invariant: the reminder is derived from the matrix, so
    // no config may describe as refused a write the matrix sends to a human.
    for (const config of allConfigs) {
      if (decide(ceilingOf(config.sandbox), config.approval, "WRITE_LOW") === "deny") continue;
      expect(buildPermissionReminder(config)).not.toMatch(/every write is refused/i);
    }
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

  it("mentions visible-set removal for tiers above the ceiling", () => {
    const text = buildPermissionReminder(readOnly);
    expect(text).toContain("已从可用工具列表移除");
  });

  it("carries the no-routing-around rule in every config", () => {
    for (const config of allConfigs) {
      expect(buildPermissionReminder(config)).toMatch(/do not use `bash`/i);
    }
  });

  it("targets the refused effect, not tool substitution in general", () => {
    // Must stay consistent with policyDenialMessage, which the model sees on
    // the same refusal; both used to read as a blanket ban on trying another
    // tool, which would forbid a write_file -> edit_file fallback.
    const text = buildPermissionReminder(ask);
    expect(text).toMatch(/do not reach the refused effect through a different tool/i);
    expect(text).toMatch(/work that was not refused is ordinary tool selection/i);
  });

  it("frames a change as a change when a previous config is given", () => {
    const text = buildPermissionReminder(auto, ask);
    expect(text).toMatch(/changed/i);
  });

  it("does not frame the first announcement as a change", () => {
    expect(buildPermissionReminder(ask)).not.toMatch(/changed/i);
  });
});
