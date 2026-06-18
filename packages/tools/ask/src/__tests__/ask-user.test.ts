import { describe, it, expect } from "vitest";
import type { ApprovalGate, EventSink } from "@volto/core";
import { createAskUserTool } from "../index.js";

function createMockApprovalGate(decision: "allow" | "deny"): ApprovalGate {
  return {
    async ask() { return decision; },
  };
}

function createMockEventSink(): EventSink & { events: Array<{ type: string; data: Record<string, unknown> }> } {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  return {
    events,
    emit(event) { events.push(event); },
  };
}

describe("ask_user", () => {
  it("returns 'yes' when gate returns allow", async () => {
    const gate = createMockApprovalGate("allow");
    const sink = createMockEventSink();
    const tool = createAskUserTool({ approvalGate: gate, eventSink: sink });
    const result = await tool.handler({ question: "Continue?" });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("yes");
    expect(sink.events.some((e) => e.type === "ask_user")).toBe(true);
  });

  it("returns 'no' when gate returns deny", async () => {
    const gate = createMockApprovalGate("deny");
    const sink = createMockEventSink();
    const tool = createAskUserTool({ approvalGate: gate, eventSink: sink });
    const result = await tool.handler({ question: "Proceed?" });
    expect(result.modelContent).toContain("no");
  });

  it("returns isError when gate throws (host unavailable)", async () => {
    const gate: ApprovalGate = { async ask() { throw new Error("no host"); } };
    const sink = createMockEventSink();
    const tool = createAskUserTool({ approvalGate: gate, eventSink: sink });
    const result = await tool.handler({ question: "?" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("not available");
  });

  it("has no required capabilities", () => {
    const tool = createAskUserTool({ approvalGate: createMockApprovalGate("allow"), eventSink: createMockEventSink() });
    expect(tool.definition.requires).toEqual([]);
  });
});
