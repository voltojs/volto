import { describe, it, expect, vi } from "vitest";
import { createApprovalRegistry } from "../approval-gate.js";

const call = (id: string, name = "bash") => ({ id, name, input: {} });

describe("createApprovalRegistry", () => {
  it("keeps ask() pending until a decision settles it", async () => {
    const registry = createApprovalRegistry({ onAlwaysAllow: () => {} });

    const pending = registry.gate.ask(call("c1"), "WRITE_HIGH");
    expect(registry.size()).toBe(1);

    registry.settle("c1", "allow");

    await expect(pending).resolves.toBe("allow");
    expect(registry.size()).toBe(0);
  });

  it("resolves deny for a denied call", async () => {
    const registry = createApprovalRegistry({ onAlwaysAllow: () => {} });

    const pending = registry.gate.ask(call("c1"), "WRITE_HIGH");
    registry.settle("c1", "deny");

    await expect(pending).resolves.toBe("deny");
  });

  it("records an always-allow rule before resolving allow", async () => {
    const onAlwaysAllow = vi.fn();
    const registry = createApprovalRegistry({ onAlwaysAllow });

    const pending = registry.gate.ask(call("c1", "write_file"), "WRITE_HIGH");
    registry.settle("c1", "allow_always");

    await expect(pending).resolves.toBe("allow");
    expect(onAlwaysAllow).toHaveBeenCalledWith("write_file");
  });

  it("does not record a rule for a one-shot allow", async () => {
    const onAlwaysAllow = vi.fn();
    const registry = createApprovalRegistry({ onAlwaysAllow });

    const pending = registry.gate.ask(call("c1"), "WRITE_HIGH");
    registry.settle("c1", "allow");
    await pending;

    expect(onAlwaysAllow).not.toHaveBeenCalled();
  });

  it("reports false for an unknown callId and leaves others pending", async () => {
    const registry = createApprovalRegistry({ onAlwaysAllow: () => {} });

    const pending = registry.gate.ask(call("c1"), "WRITE_HIGH");

    expect(registry.settle("nope", "allow")).toBe(false);
    expect(registry.size()).toBe(1);

    registry.settle("c1", "allow");
    await expect(pending).resolves.toBe("allow");
  });

  it("settles a callId only once", async () => {
    const registry = createApprovalRegistry({ onAlwaysAllow: () => {} });

    const pending = registry.gate.ask(call("c1"), "WRITE_HIGH");
    expect(registry.settle("c1", "allow")).toBe(true);
    expect(registry.settle("c1", "deny")).toBe(false);

    await expect(pending).resolves.toBe("allow");
  });

  it("fails closed: settleAll denies every pending approval", async () => {
    const registry = createApprovalRegistry({ onAlwaysAllow: () => {} });

    const first = registry.gate.ask(call("c1"), "WRITE_HIGH");
    const second = registry.gate.ask(call("c2"), "IRREVERSIBLE");

    registry.settleAll("deny");

    await expect(first).resolves.toBe("deny");
    await expect(second).resolves.toBe("deny");
    expect(registry.size()).toBe(0);
  });
});

describe("always-allow rule accumulation", () => {
  it("unshifts a granted tool so it outranks an earlier deny", async () => {
    const rules: Array<{ toolName?: string; decision: string }> = [
      { toolName: "bash", decision: "deny" },
    ];
    const registry = createApprovalRegistry({
      onAlwaysAllow: (toolName) => rules.unshift({ toolName, decision: "allow" }),
    });

    const pending = registry.gate.ask(call("c1", "bash"), "WRITE_HIGH");
    registry.settle("c1", "allow_always");
    await pending;

    expect(rules[0]).toEqual({ toolName: "bash", decision: "allow" });
  });
});
