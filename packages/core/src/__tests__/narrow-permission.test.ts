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
