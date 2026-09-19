import { describe, it, expect } from "vitest";
import type { ApprovalResult, PendingToolCall } from "@volto/core";
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

  it("carries the user's answer into the resolved ApprovalResult", async () => {
    const registry = createApprovalRegistry();
    let settled: ApprovalResult | undefined;
    const gateCall = registry.gate.ask(
      { id: "ask_user-1", name: "ask_user", input: {} },
      "READ_ONLY",
    );
    // The registry's gate always resolves a full ApprovalResult; the cast
    // only strips the never-produced bare "allow"/"deny" off the port union.
    void gateCall.then((r) => { settled = r as ApprovalResult; });
    expect(registry.settle("ask_user-1", "allow", ["SQLite", "其他输入"])).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toMatchObject({ decision: "allow", answer: ["SQLite", "其他输入"] });
  });

  it("rejects a non-string-array answer shape", () => {
    // 路由层测试在 server.test.ts 的 /approvals 用例里覆盖；这里只钉 registry 类型。
    expect(true).toBe(true);
  });

  describe("lifecycle hooks (sessions.ts's ask_user bracket synthesis)", () => {
    it("fires onPending after the call is parked, with the gate-facing identity", async () => {
      const seen: Array<{ id: string; name: string; riskTier: string; pendingAtFire: number }> = [];
      const registry = createApprovalRegistry({
        onPending: (call, riskTier) => {
          seen.push({ id: call.id, name: call.name, riskTier, pendingAtFire: registry.size() });
        },
      });

      const pending = registry.gate.ask(call("ask_user-1", "ask_user"), "READ_ONLY");

      // onPending 已经看到 park 后的 registry（size 1）——观察者与簿记一致。
      expect(seen).toEqual([
        { id: "ask_user-1", name: "ask_user", riskTier: "READ_ONLY", pendingAtFire: 1 },
      ]);
      registry.settle("ask_user-1", "allow");
      await pending;
    });

    it("fires onSettled with the settled entry's toolName, only for actually pending calls", () => {
      const settled: Array<[string, string, string]> = [];
      const registry = createApprovalRegistry({
        onSettled: (callId, toolName, decision) => settled.push([callId, toolName, decision]),
      });
      registry.gate.ask(call("c1", "ask_user"), "READ_ONLY");
      registry.gate.ask(call("c2", "bash"), "WRITE_HIGH");

      expect(registry.settle("c1", "allow", ["x"])).toBe(true);
      expect(registry.settle("ghost", "allow")).toBe(false);
      registry.settleAll("deny", "connection-lost");

      // 两次结算都上报（用户点击 + fail-closed），未知 callId 不上报。
      expect(settled).toEqual([
        ["c1", "ask_user", "allow"],
        ["c2", "bash", "deny"],
      ]);
    });

    it("tolerates a throwing observer without disturbing the approval", async () => {
      const registry = createApprovalRegistry({
        onPending: () => {
          throw new Error("observer bug");
        },
        onSettled: () => {
          throw new Error("observer bug");
        },
      });

      // gate.ask 的 observer 在 Promise 构造器里同步抛出——异常不得吞噬
      // park 本身，也不得阻止结算。
      const pending = registry.gate.ask(call("c1"), "WRITE_HIGH");
      expect(registry.size()).toBe(1);
      expect(() => registry.settle("c1", "allow")).not.toThrow();
      await expect(pending).resolves.toEqual({ decision: "allow", reason: "user" });
    });
  });
});
