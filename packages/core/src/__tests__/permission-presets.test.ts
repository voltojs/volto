import { describe, it, expect } from "vitest";
import {
  PERMISSION_PRESETS,
  permissionConfigOf,
  presetOf,
  isWiderThan,
  allowedPresetsFor,
  narrowToParent,
  type PermissionPreset,
} from "../permission-presets.js";
import type { PermissionConfig } from "../permission-policy.js";

const cfg = (sandbox: PermissionConfig["sandbox"], approval: PermissionConfig["approval"]): PermissionConfig => ({
  sandbox,
  approval,
});

describe("permission presets", () => {
  it("lists the presets in escalating order", () => {
    expect(PERMISSION_PRESETS).toEqual(["read-only", "plan", "ask", "auto", "full"]);
  });

  it("maps each preset to a fresh config object", () => {
    expect(permissionConfigOf("read-only")).toEqual(cfg("read-only", "never"));
    expect(permissionConfigOf("plan")).toEqual(cfg("read-only", "never"));
    expect(permissionConfigOf("ask")).toEqual(cfg("workspace-write", "ask"));
    expect(permissionConfigOf("auto")).toEqual(cfg("workspace-write", "never"));
    expect(permissionConfigOf("full")).toEqual(cfg("danger-full-access", "never"));

    // Never hand out a shared mutable object.
    const a = permissionConfigOf("ask");
    a.sandbox = "read-only";
    expect(permissionConfigOf("ask").sandbox).toBe("workspace-write");
  });

  it("round-trips a config back to its preset, and says so when it cannot", () => {
    for (const preset of PERMISSION_PRESETS) {
      // `plan` and `read-only` are the same config, so only the first is
      // recoverable — the config cannot carry the difference.
      const expected = preset === "plan" ? "read-only" : preset;
      expect(presetOf(permissionConfigOf(preset))).toBe(expected);
    }
    // A combination no preset expresses (danger-full-access + ask) has no id;
    // callers must fall back to rendering the raw config.
    expect(presetOf(cfg("danger-full-access", "ask"))).toBeUndefined();
  });

  it("judges width on the sandbox axis only", () => {
    // Asking for a stricter approval is not "wider": a sub-agent's ask is
    // already refused by its own gate, and the shared narrowing turns it into
    // the parent's value anyway.
    expect(isWiderThan("auto", cfg("workspace-write", "ask"))).toBe(false);
    expect(isWiderThan("full", cfg("workspace-write", "ask"))).toBe(true);
    expect(isWiderThan("read-only", cfg("workspace-write", "never"))).toBe(false);
    expect(isWiderThan("ask", cfg("read-only", "never"))).toBe(true);
  });

  it("lists the presets a parent may dispatch", () => {
    expect(allowedPresetsFor(cfg("read-only", "never"))).toEqual(["read-only", "plan"]);
    expect(allowedPresetsFor(cfg("workspace-write", "ask"))).toEqual([
      "read-only",
      "plan",
      "ask",
      "auto",
    ]);
    expect(allowedPresetsFor(cfg("danger-full-access", "never"))).toEqual([
      ...PERMISSION_PRESETS,
    ]);
  });

  it("narrows a request into the parent and reports the request", () => {
    const parent = cfg("workspace-write", "never");
    expect(narrowToParent(parent, "read-only")).toEqual({
      config: cfg("read-only", "never"),
      requestedPreset: "read-only",
    });
    // No request → the parent, copied (never an alias).
    const inherited = narrowToParent(parent);
    expect(inherited.config).toEqual(parent);
    expect(inherited.config).not.toBe(parent);
    expect(inherited.requestedPreset).toBeUndefined();
  });

  it("keeps the parent's rules when the request names the boundary it already has", () => {
    // Narrowing through the preset would rebuild the config and lose `rules`,
    // making "ask for auto on an auto session" behave unlike "ask for nothing".
    const parent: PermissionConfig = {
      sandbox: "workspace-write",
      approval: "never",
      rules: [{ capability: "net:fetch", decision: "deny" }],
    };
    const narrowed = narrowToParent(parent, "auto");
    expect(narrowed.config.rules).toEqual([{ capability: "net:fetch", decision: "deny" }]);
  });

  it("never widens, even when asked", () => {
    // The author-facing face relies on this: an over-broad request collapses
    // to the parent instead of failing a build.
    const parent = cfg("read-only", "never");
    const narrowed = narrowToParent(parent, "full" as PermissionPreset);
    expect(narrowed.config.sandbox).toBe("read-only");
    expect(narrowed.requestedPreset).toBe("full");
  });
});