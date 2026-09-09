import { describe, it, expect } from "vitest";
import {
  buildPermissionConfig,
  isUiPermissionMode,
  normaliseUiPermissionMode,
  sandboxModeFor,
  UI_PERMISSION_MODES,
} from "../permission-modes.js";

describe("UI_PERMISSION_MODES", () => {
  it("advertises the four presets in escalating order", () => {
    expect(UI_PERMISSION_MODES).toEqual(["read-only", "ask", "auto", "full"]);
  });
});

describe("buildPermissionConfig", () => {
  it("maps read-only to a boundary that denies every write", () => {
    expect(buildPermissionConfig("read-only")).toEqual({
      sandbox: "read-only",
      approval: "never",
    });
  });

  it("maps ask to workspace-write with human approval", () => {
    expect(buildPermissionConfig("ask")).toEqual({
      sandbox: "workspace-write",
      approval: "ask",
    });
  });

  it("maps auto to workspace-write without prompts", () => {
    expect(buildPermissionConfig("auto")).toEqual({
      sandbox: "workspace-write",
      approval: "never",
    });
  });

  it("maps full to unrestricted access", () => {
    expect(buildPermissionConfig("full")).toEqual({
      sandbox: "danger-full-access",
      approval: "never",
    });
  });
});

describe("sandboxModeFor", () => {
  it("returns the sandbox knob each preset bundles", () => {
    expect(sandboxModeFor("read-only")).toBe("read-only");
    expect(sandboxModeFor("ask")).toBe("workspace-write");
    expect(sandboxModeFor("auto")).toBe("workspace-write");
    expect(sandboxModeFor("full")).toBe("danger-full-access");
  });
});

describe("isUiPermissionMode", () => {
  it("accepts every current preset", () => {
    for (const mode of UI_PERMISSION_MODES) {
      expect(isUiPermissionMode(mode)).toBe(true);
    }
  });

  it("rejects retired names on the write path", () => {
    // Legacy values are readable (see normaliseUiPermissionMode) but must
    // never be accepted from a client request.
    expect(isUiPermissionMode("plan")).toBe(false);
    expect(isUiPermissionMode("auto-accept")).toBe(false);
    expect(isUiPermissionMode("default")).toBe(false);
    expect(isUiPermissionMode(undefined)).toBe(false);
    expect(isUiPermissionMode(42)).toBe(false);
  });
});

describe("normaliseUiPermissionMode", () => {
  it("passes current presets through", () => {
    expect(normaliseUiPermissionMode("full")).toBe("full");
  });

  it("migrates plan to read-only", () => {
    expect(normaliseUiPermissionMode("plan")).toBe("read-only");
  });

  it("migrates auto-accept to auto", () => {
    expect(normaliseUiPermissionMode("auto-accept")).toBe("auto");
  });

  it("falls back to ask for anything unrecognised", () => {
    expect(normaliseUiPermissionMode(null)).toBe("ask");
    expect(normaliseUiPermissionMode(undefined)).toBe("ask");
    expect(normaliseUiPermissionMode("nonsense")).toBe("ask");
  });

  it("falls back to ask for Object.prototype member names, not their inherited value", () => {
    // A bare `LEGACY_ALIASES[value]` lookup does not distinguish an own
    // property from one inherited off Object.prototype, so strings like
    // "constructor" or "toString" must not resolve to that inherited value.
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(normaliseUiPermissionMode(name)).toBe("ask");
    }
  });
});

describe("preset / sandbox coherence", () => {
  it("each preset's permissionConfig.sandbox agrees with sandboxModeFor", () => {
    // The decision layer and the enforcement layer must never disagree: if
    // these drift, a preset would decide "allow" for a write the sandbox
    // then refuses (or worse, the other way round).
    for (const mode of UI_PERMISSION_MODES) {
      expect(buildPermissionConfig(mode).sandbox).toBe(sandboxModeFor(mode));
    }
  });
});
