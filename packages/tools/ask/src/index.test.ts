import { describe, it, expect } from "vitest";
import { createAskUserTool } from "./index.js";
import type { ApprovalGate, EventSink, PendingToolCall, RiskTier } from "@voltojs/core";

function harness(gateResult: { decision: "allow" | "deny"; answer?: string[] }) {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const eventSink: EventSink = { emit: (e) => events.push(e as never) };
  const gate: ApprovalGate = {
    ask: async (_call: PendingToolCall, _tier: RiskTier) => gateResult,
  };
  const tool = createAskUserTool({ approvalGate: gate, eventSink });
  return { tool, events };
}

describe("ask_user v2", () => {
  it("carries options and multiSelect on the ask_user event", async () => {
    const { tool, events } = harness({ decision: "allow", answer: ["A"] });
    await tool.handler(
      { question: "选一个", options: [{ label: "A" }, { label: "B" }], multiSelect: true },
    );
    const ask = events.find((e) => e.type === "ask_user")!;
    expect(ask.data).toMatchObject({ question: "选一个", multiSelect: true });
    expect(ask.data.options).toHaveLength(2);
  });

  it("returns the user's answers joined when allowed", async () => {
    const { tool } = harness({ decision: "allow", answer: ["SQLite", "再加缓存"] });
    const result = await tool.handler({ question: "存储？" });
    expect(result.modelContent).toContain("SQLite");
    expect(result.modelContent).toContain("再加缓存");
    expect(result.isError).toBeUndefined();
  });

  it("reports a skipped question as plain text, not an error", async () => {
    const { tool } = harness({ decision: "deny" });
    const result = await tool.handler({ question: "存储？" });
    expect(result.modelContent).toContain("did not answer");
    expect(result.isError).toBeUndefined();
  });
});
