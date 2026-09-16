import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { Message } from "../state.js";
import type { Id } from "../ports.js";

const idPort: Id = (() => {
  let n = 0;
  return { next: () => `n${++n}` };
})();
const ctx: StepContext = { tools: [], model: "m", id: idPort };

function base(messages: Message[]): ReducerState {
  return { ...createInitialState(), messages, status: "idle" };
}

describe("compaction_applied", () => {
  it("replaces the selected span with one summary at the earliest position", () => {
    const messages: Message[] = [
      { id: "sys", role: "system", content: "S" },
      { id: "a", role: "user", content: "old1" },
      { id: "b", role: "user", content: "old2" },
      { id: "c", role: "user", content: "recent" },
    ];
    const { state, effects } = step(
      base(messages),
      {
        type: "compaction_applied",
        summaryId: "sum-1",
        summaryText: "checkpoint",
        replacedIds: ["a", "b"],
      },
      ctx,
    );
    expect(state.messages.map((m) => m.id)).toEqual(["sys", "sum-1", "c"]);
    const sum = state.messages.find((m) => m.id === "sum-1")!;
    expect(sum.role).toBe("system");
    expect(String(sum.content)).toContain("[Earlier conversation summary]");
    expect(String(sum.content)).toContain("checkpoint");
    const emit = effects.find((e) => e.type === "emit" && e.event?.type === "compaction");
    expect(emit).toBeDefined();
  });

  it("drops replaced pins and ignores unknown ids", () => {
    const messages: Message[] = [
      { id: "sys", role: "system", content: "S" },
      { id: "a", role: "user", content: "pinned old" },
      { id: "c", role: "user", content: "recent" },
    ];
    const { state } = step(
      { ...base(messages), pinnedMessageIds: ["a", "ghost"] },
      {
        type: "compaction_applied",
        summaryId: "sum-1",
        summaryText: "s",
        replacedIds: ["a", "missing"],
      },
      ctx,
    );
    expect(state.pinnedMessageIds).toEqual(["ghost"]);
    expect(state.messages.map((m) => m.id)).toEqual(["sys", "sum-1", "c"]);
  });
});

describe("tool_results_pruned", () => {
  it("rewrites tool_result content by toolCallId", () => {
    const messages: Message[] = [
      { id: "sys", role: "system", content: "S" },
      { id: "t", role: "tool", content: [{ type: "tool_result", toolUseId: "call-1", content: [{ type: "text", text: "LONG" }] }] },
    ];
    const { state } = step(
      base(messages),
      {
        type: "tool_results_pruned",
        entries: [{ toolCallId: "call-1", charsBefore: 4, charsAfter: 2, content: "PR" }],
      },
      ctx,
    );
    const tool = state.messages.find((m) => m.role === "tool")!;
    const block = (tool.content as Array<{ type: string; content: Array<{ type: string; text: string }> }>)[0]!;
    expect(block.content).toEqual([{ type: "text", text: "PR" }]);
  });
});
