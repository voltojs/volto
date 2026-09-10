import { describe, it, expect } from "vitest";
import { createApprovalRegistry } from "../approval-gate.js";

const call = (id: string, name = "bash") => ({ id, name, input: {} });

describe("createApprovalRegistry", () => {
  it("keeps ask() pending until a decision settles it", async () => {
    const registry = createApprovalRegistry();

    const pending = registry.gate.ask(call("c1"), "WRITE_HIGH");
    expect(registry.size()).toBe(1);

    registry.settle("c1", "allow");

    await expect(pending).resolves.toBe("allow");
    expect(registry.size()).toBe(0);
  });

  it("resolves deny for a denied call", async () => {
    const registry = createApprovalRegistry();

    const pending = registry.gate.ask(call("c1"), "WRITE_HIGH");
    registry.settle("c1", "deny");

    await expect(pending).resolves.toBe("deny");
  });

  it("reports false for an unknown callId and leaves others pending", async () => {
    const registry = createApprovalRegistry();

    const pending = registry.gate.ask(call("c1"), "WRITE_HIGH");

    expect(registry.settle("nope", "allow")).toBe(false);
    expect(registry.size()).toBe(1);

    registry.settle("c1", "allow");
    await expect(pending).resolves.toBe("allow");
  });

  it("settles a callId only once", async () => {
    const registry = createApprovalRegistry();

    const pending = registry.gate.ask(call("c1"), "WRITE_HIGH");
    expect(registry.settle("c1", "allow")).toBe(true);
    expect(registry.settle("c1", "deny")).toBe(false);

    await expect(pending).resolves.toBe("allow");
  });

  it("fails closed: settleAll denies every pending approval", async () => {
    const registry = createApprovalRegistry();

    const first = registry.gate.ask(call("c1"), "WRITE_HIGH");
    const second = registry.gate.ask(call("c2"), "IRREVERSIBLE");

    registry.settleAll("deny");

    await expect(first).resolves.toBe("deny");
    await expect(second).resolves.toBe("deny");
    expect(registry.size()).toBe(0);
  });
});
