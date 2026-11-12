import { describe, it, expect } from "vitest";
import { buildTurnRecords, toConversationView } from "../view-projection.js";
import type { ConversationBlock } from "../view-projection.js";
import type { TranscriptEvent } from "../ports.js";

// Inline event helper: seq auto-increments and time strictly increases —
// buildTurnRecords relies on both being stamped.
let seq = 0;
let time = 1000;
function ev(turn: number, type: string, data: Record<string, unknown>, step?: number): TranscriptEvent {
  seq += 1;
  time += 1;
  return { seq, time, turn, ...(step === undefined ? {} : { step }), type, data } as unknown as TranscriptEvent;
}

/** The conversation view's tool_call blocks, in feed order. */
function conversationCalls(records: ReturnType<typeof buildTurnRecords>) {
  return toConversationView(records)
    .messages.flatMap((m) => m.blocks)
    .filter((b): b is Extract<ConversationBlock, { type: "tool_call" }> => b.type === "tool_call");
}

describe("buildTurnRecords acceptance projection", () => {
  it("projects verification from a task tool_result displayMetadata", () => {
    const records = buildTurnRecords([
      ev(0, "tool_call", { callId: "c1", name: "task", input: { message: "x" } }, 1),
      ev(0, "tool_result", {
        callId: "c1", content: "[{\"type\":\"text\",\"text\":\"out\"}]", isError: true, orderInBatch: 0,
        displayMetadata: { taskId: "t1", verification: { status: "failed", attempts: 2, failures: ["no tests"] } },
      }, 1),
      ev(0, "turn_end", { reason: "done" }, 1),
    ]);
    expect(records[0]!.steps[0]!.toolCalls[0]!.verification).toEqual({
      status: "failed", attempts: 2, failures: ["no tests"],
    });
  });

  it("applies a late subagent_finished verdict to the dispatch call of an earlier turn", () => {
    const base = [
      ev(0, "tool_call", { callId: "c1", name: "task", input: { message: "x", run_in_background: true } }, 1),
      ev(0, "tool_result", { callId: "c1", content: "started", isError: false, orderInBatch: 0, displayMetadata: { taskId: "t1", background: true } }, 1),
      ev(0, "subagent_started", { childSessionId: "s-sub-1", label: "task", depth: 1, taskId: "t1" }),
      ev(0, "turn_end", { reason: "done" }, 1),
      ev(1, "user_message", { content: "next" }), ev(1, "turn_end", { reason: "done" }, 1),
    ];
    const prev = buildTurnRecords(base as never);
    const late = ev(0, "subagent_finished", {
      childSessionId: "s-sub-1", isError: true, durationMs: 5, taskId: "t1",
      verification: { status: "failed", attempts: 1, failures: ["no tests"] },
    });
    const next = buildTurnRecords([...base, late] as never, prev);
    expect(next[0]!.steps[0]!.toolCalls[0]!.verification?.status).toBe("failed");
    expect(next[0]).not.toBe(prev[0]);
    expect(next[1]).toBe(prev[1]);
  });

  it("stamps a late failed verdict's isError and child duration onto the dispatch call", () => {
    const base = [
      ev(0, "tool_call", { callId: "c1", name: "task", input: { message: "x", run_in_background: true } }, 1),
      ev(0, "tool_result", { callId: "c1", content: "started", isError: false, durationMs: 1, orderInBatch: 0, displayMetadata: { taskId: "t1", background: true } }, 1),
      ev(0, "subagent_started", { childSessionId: "s-sub-1", label: "task", depth: 1, taskId: "t1" }),
      ev(0, "turn_end", { reason: "done" }, 1),
      ev(1, "user_message", { content: "next" }), ev(1, "turn_end", { reason: "done" }, 1),
    ];
    const prev = buildTurnRecords(base as never);
    const late = ev(0, "subagent_finished", {
      childSessionId: "s-sub-1", isError: true, durationMs: 130, taskId: "t1",
      verification: { status: "failed", attempts: 1, failures: ["no tests"] },
    });
    const next = buildTurnRecords([...base, late] as never, prev);
    const call = next[0]!.steps[0]!.toolCalls[0]!;
    expect(call.verification?.status).toBe("failed");
    expect(call.isError).toBe(true);
    expect(call.durationMs).toBe(130);
    expect(next[0]).not.toBe(prev[0]);
    expect(next[1]).toBe(prev[1]);
  });

  it("applies a late passed verdict's child duration without writing isError false", () => {
    const base = [
      ev(0, "tool_call", { callId: "c1", name: "task", input: { message: "x", run_in_background: true } }, 1),
      // No isError on the dispatch result: the late bracket must leave it unset.
      ev(0, "tool_result", { callId: "c1", content: "started", durationMs: 3, orderInBatch: 0, displayMetadata: { taskId: "t1", background: true } }, 1),
      ev(0, "subagent_started", { childSessionId: "s-sub-1", label: "task", depth: 1, taskId: "t1" }),
      ev(0, "turn_end", { reason: "done" }, 1),
      ev(1, "user_message", { content: "next" }), ev(1, "turn_end", { reason: "done" }, 1),
    ];
    const prev = buildTurnRecords(base as never);
    const late = ev(0, "subagent_finished", {
      childSessionId: "s-sub-1", isError: false, durationMs: 3849, taskId: "t1",
      verification: { status: "passed", attempts: 1, failures: [] },
    });
    const next = buildTurnRecords([...base, late] as never, prev);
    const call = next[0]!.steps[0]!.toolCalls[0]!;
    expect(call.verification?.status).toBe("passed");
    expect(call.durationMs).toBe(3849);
    expect(call.isError).toBeUndefined();
  });

  it("projects no verification field for old logs without a verdict", () => {
    const records = buildTurnRecords([
      ev(0, "tool_call", { callId: "c1", name: "task", input: { message: "x" } }, 1),
      ev(0, "assistant_message", {
        content: [{ type: "tool_use", id: "c1", name: "task", input: { message: "x" } }],
        stopReason: "tool_use", durationMs: 5,
      }, 1),
      ev(0, "tool_result", { callId: "c1", content: "out", isError: false, orderInBatch: 0, displayMetadata: { taskId: "t1" } }, 1),
      ev(0, "subagent_started", { childSessionId: "s-sub-1", label: "task", depth: 1, taskId: "t1" }),
      ev(0, "subagent_finished", { childSessionId: "s-sub-1", isError: false, durationMs: 5, taskId: "t1" }),
      ev(0, "turn_end", { reason: "done" }, 1),
    ] as never);
    expect(records[0]!.steps[0]!.toolCalls[0]!.verification).toBeUndefined();
    const calls = conversationCalls(records);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.call.verification).toBeUndefined();
    expect("verification" in calls[0]!.call).toBe(false);
  });

  it("carries a sync verdict through toConversationView", () => {
    const records = buildTurnRecords([
      ev(0, "tool_call", { callId: "c1", name: "task", input: { message: "x" } }, 1),
      ev(0, "assistant_message", {
        content: [{ type: "tool_use", id: "c1", name: "task", input: { message: "x" } }],
        stopReason: "tool_use", durationMs: 5,
      }, 1),
      ev(0, "tool_result", {
        callId: "c1", content: "out", isError: false, orderInBatch: 0,
        displayMetadata: { taskId: "t1", verification: { status: "passed", attempts: 1, failures: [] } },
      }, 1),
      ev(0, "turn_end", { reason: "done" }, 1),
    ]);
    const calls = conversationCalls(records);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.call.verification).toEqual({ status: "passed", attempts: 1, failures: [] });
  });
});
