import { describe, it, expect } from "vitest";
import { narrowPermission, evaluatePermission } from "../index.js";
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

  it("returns a shallow copy of the parent config when the child declares nothing", () => {
    const out = narrowPermission(parent, undefined);
    expect(out).not.toBe(parent);
    expect(out).toEqual(parent);
  });

  // Security: rules outrank the matrix (first-match-wins), so a child `allow`
  // would bypass the narrowed sandbox×approval. Dropping child allows must
  // close that path — verified through evaluatePermission, not just the
  // composed array.
  it("closes the child-allow bypass of the narrowed matrix", () => {
    // Parent has no rules of its own: the matrix must decide after the
    // child allow is dropped.
    const rulelessParent: PermissionConfig = { sandbox: "workspace-write", approval: "ask" };
    const out = narrowPermission(rulelessParent, {
      sandbox: "danger-full-access",
      approval: "never",
      rules: [{ toolName: "bash", decision: "allow" }],
    });
    // Child allow is dropped entirely — nothing in the composed rules may allow bash.
    expect((out.rules ?? []).some((r) => r.toolName === "bash" && r.decision === "allow")).toBe(false);
    // Parent was workspace-write+ask; bash is WRITE_HIGH, so the matrix still asks.
    expect(evaluatePermission(out, "bash", "WRITE_HIGH")).toBe("ask");
  });

  it("keeps a child deny even when the parent allows the same tool", () => {
    const permissiveParent: PermissionConfig = {
      sandbox: "danger-full-access",
      approval: "never",
      rules: [{ toolName: "bash", decision: "allow" }],
    };
    const out = narrowPermission(permissiveParent, {
      sandbox: "danger-full-access",
      approval: "never",
      rules: [{ toolName: "bash", decision: "deny" }],
    });
    expect(evaluatePermission(out, "bash", "WRITE_HIGH")).toBe("deny");
  });

  // A parent `allow` is an exemption granted to the parent session (often a
  // user's "always allow this tool"). Rules outrank the matrix, so carrying
  // it into a child narrowed to read-only would let the child write anyway —
  // the definition's sandbox would be decoration.
  it("drops a parent allow rule when the child declares its own policy", () => {
    const exemptingParent: PermissionConfig = {
      sandbox: "workspace-write",
      approval: "ask",
      rules: [{ toolName: "edit_file", decision: "allow" }],
    };
    const out = narrowPermission(exemptingParent, { sandbox: "read-only", approval: "ask" });
    expect(out.sandbox).toBe("read-only");
    expect(evaluatePermission(out, "edit_file", "WRITE_LOW")).not.toBe("allow");
  });

  it("keeps a parent allow rule when there is no child policy to narrow to", () => {
    const exemptingParent: PermissionConfig = {
      sandbox: "workspace-write",
      approval: "ask",
      rules: [{ toolName: "edit_file", decision: "allow" }],
    };
    // No definition policy: the child runs the parent's boundary as-is, so
    // the parent's own exemptions still apply.
    expect(evaluatePermission(narrowPermission(exemptingParent, undefined), "edit_file", "WRITE_LOW")).toBe(
      "allow",
    );
  });

  it("keeps a parent deny rule even when the child declares a policy", () => {
    const out = narrowPermission(parent, { sandbox: "read-only", approval: "ask" });
    expect(evaluatePermission(out, "bash", "WRITE_HIGH")).toBe("deny");
  });

  it("keeps a child ask rule so the matrix cannot silently allow it", () => {
    const lenientParent: PermissionConfig = { sandbox: "danger-full-access", approval: "never" };
    const out = narrowPermission(lenientParent, {
      sandbox: "danger-full-access",
      approval: "never",
      rules: [{ toolName: "git_push", decision: "ask" }],
    });
    expect(evaluatePermission(out, "git_push", "IRREVERSIBLE")).toBe("ask");
  });
});
