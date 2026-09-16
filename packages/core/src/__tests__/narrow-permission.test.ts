import { describe, it, expect } from "vitest";
import { narrowPermission } from "../index.js";
import type { PermissionConfig } from "../index.js";

const parent: PermissionConfig = {
  sandbox: "workspace-write",
  approval: "ask",
  rules: [{ toolName: "bash", decision: "deny" }],
};

describe("narrowPermission", () => {
  it("keeps the stricter sandbox when the child asks for more", () => {
    const out = narrowPermission(parent, { sandbox: "danger-full-access", approval: "never" });
    expect(out.sandbox).toBe("workspace-write");
  });

  it("adopts the child sandbox when it is stricter", () => {
    const out = narrowPermission(parent, { sandbox: "read-only", approval: "ask" });
    expect(out.sandbox).toBe("read-only");
  });

  it("treats ask as stricter than never", () => {
    expect(narrowPermission(parent, { sandbox: "read-only", approval: "never" }).approval).toBe("ask");
    const lenientParent: PermissionConfig = { sandbox: "workspace-write", approval: "never" };
    expect(narrowPermission(lenientParent, { sandbox: "read-only", approval: "ask" }).approval).toBe("ask");
  });

  it("keeps parent deny rules ahead of any child allow", () => {
    const out = narrowPermission(parent, {
      sandbox: "read-only",
      approval: "ask",
      rules: [{ toolName: "bash", decision: "allow" }],
    });
    const bashRule = out.rules?.find((r) => r.toolName === "bash");
    expect(bashRule?.decision).toBe("deny");
  });

  it("returns the parent config unchanged when the child declares nothing", () => {
    expect(narrowPermission(parent, undefined)).toEqual(parent);
  });
});
