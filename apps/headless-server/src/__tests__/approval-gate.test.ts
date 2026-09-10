import { describe, it, expect } from "vitest";
import type { PendingToolCall } from "@volto/core";
import { createApprovalRegistry } from "../approval-gate.js";

const call = (id: string, name = "bash") => ({ id, name, input: {} });

describe("createApprovalRegistry", () => {
  it("keeps ask() pending until a decision settles it", async () => {
    const registry = createApprovalRegistry();

    const pending = registry.gate.ask(call("c1"), "WRITE_HIGH");
    expect(registry.size()).toBe(1);

    registry.settle("c1", "allow");

    await expect(pending).resolves.toEqual({ decision: "allow", reason: "user" });
    expect(registry.size()).toBe(0);
  });

  it("resolves deny for a denied call", async () => {
    const registry = createApprovalRegistry();

    const pending = registry.gate.ask(call("c1"), "WRITE_HIGH");
    registry.settle("c1", "deny");

    await expect(pending).resolves.toEqual({ decision: "deny", reason: "user" });
  });

  it("reports false for an unknown callId and leaves others pending", async () => {
    const registry = createApprovalRegistry();

    const pending = registry.gate.ask(call("c1"), "WRITE_HIGH");

    expect(registry.settle("nope", "allow")).toBe(false);
    expect(registry.size()).toBe(1);

    registry.settle("c1", "allow");
    await expect(pending).resolves.toEqual({ decision: "allow", reason: "user" });
  });

  it("settles a callId only once", async () => {
    const registry = createApprovalRegistry();

    const pending = registry.gate.ask(call("c1"), "WRITE_HIGH");
    expect(registry.settle("c1", "allow")).toBe(true);
    expect(registry.settle("c1", "deny")).toBe(false);

    await expect(pending).resolves.toEqual({ decision: "allow", reason: "user" });
  });

  it("fails closed: settleAll denies every pending approval", async () => {
    const registry = createApprovalRegistry();

    const first = registry.gate.ask(call("c1"), "WRITE_HIGH");
    const second = registry.gate.ask(call("c2"), "IRREVERSIBLE");

    registry.settleAll("deny", "connection-lost");

    await expect(first).resolves.toEqual({ decision: "deny", reason: "connection-lost" });
    await expect(second).resolves.toEqual({ decision: "deny", reason: "connection-lost" });
    expect(registry.size()).toBe(0);
  });

  it("labels a mass settlement with why it happened", async () => {
    const registry = createApprovalRegistry();
    const asked = registry.gate.ask(
      { id: "c1", name: "bash", input: {} } as PendingToolCall,
      "WRITE_HIGH",
    );

    registry.settleAll("deny", "connection-lost");

    await expect(asked).resolves.toEqual({
      decision: "deny",
      reason: "connection-lost",
    });
  });

  it("labels a user decision as such", async () => {
    const registry = createApprovalRegistry();
    const asked = registry.gate.ask(
      { id: "c1", name: "bash", input: {} } as PendingToolCall,
      "WRITE_HIGH",
    );

    registry.settle("c1", "deny");

    await expect(asked).resolves.toEqual({ decision: "deny", reason: "user" });
  });
});
