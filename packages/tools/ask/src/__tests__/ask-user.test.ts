import { describe, it, expect } from "vitest";
import type { ApprovalGate, EventSink } from "@voltojs/core";
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

  it("returns plain text 'did not answer' when gate returns deny", async () => {
    const gate = createMockApprovalGate("deny");
    const sink = createMockEventSink();
    const tool = createAskUserTool({ approvalGate: gate, eventSink: sink });
    const result = await tool.handler({ question: "Proceed?" });
    expect(result.modelContent).toContain("did not answer");
    expect(result.isError).toBeFalsy();
  });

  it("normalizes an ApprovalResult allow the same as a bare allow", async () => {
    // Gates may answer with { decision } instead of a bare string; comparing
    // an object to "allow" is always false and would flip yes into no.
    const gate: ApprovalGate = {
      async ask() {
        return { decision: "allow" as const };
      },
    };
    const sink = createMockEventSink();
    const tool = createAskUserTool({ approvalGate: gate, eventSink: sink });
    const result = await tool.handler({ question: "Continue?" });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("yes");
  });

  it("normalizes an ApprovalResult deny the same as a bare deny", async () => {
    const gate: ApprovalGate = {
      async ask() {
        return { decision: "deny" as const, reason: "user" as const };
      },
    };
    const sink = createMockEventSink();
    const tool = createAskUserTool({ approvalGate: gate, eventSink: sink });
    const result = await tool.handler({ question: "Proceed?" });
    expect(result.modelContent).toContain("did not answer");
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

  // -- C1: a hardcoded, non-unique call id lets a second concurrent -------
  // -- ask_user call silently overwrite the first's pending entry in any ---
  // -- gate keyed by call id (e.g. the gateway's real approval registry), --
  // -- orphaning the first call's promise forever.

  it("lets two concurrent calls both settle instead of one orphaning the other", async () => {
    // A gate that mimics the registry's real pending.set(call.id, ...)
    // semantics: a second ask() with the same id silently overwrites the
    // first's resolver, orphaning it forever. A unique id per call must
    // prevent that collision.
    const pending = new Map<string, (d: "allow" | "deny") => void>();
    const gate: ApprovalGate = {
      ask(call) {
        return new Promise((resolve) => {
          pending.set(call.id, resolve);
        });
      },
    };
    const sink = createMockEventSink();
    const tool = createAskUserTool({ approvalGate: gate, eventSink: sink });

    const p1 = tool.handler({ question: "first?" });
    const p2 = tool.handler({ question: "second?" });

    // Both calls must have registered distinct pending entries — otherwise
    // the second call's ask() has already clobbered the first's.
    expect(pending.size).toBe(2);

    for (const resolve of pending.values()) resolve("allow");

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
  });
});
