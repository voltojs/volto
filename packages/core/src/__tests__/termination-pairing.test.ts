/**
 * Termination pairing (D12) — every termination path that clears the tool
 * roster must leave the message history with each assistant `tool_use` id
 * paired by a `tool_result` of the same id. Providers (Anthropic and OpenAI
 * alike) reject a request whose tail assistant message carries un-paired
 * `tool_use` entries outright, so a turn that dies mid-batch must close the
 * pair itself: an already-buffered real result is kept as-is (flushing it is
 * more truthful than replacing it), and every missing one is synthesized
 * with `isError: true` and the tier's frozen wording.
 */

import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { AgentInput } from "../input.js";
import type { Effect } from "../effect.js";
import type { ToolDefinition } from "../tool.js";
import type { Message, ToolResultContent } from "../state.js";

// ──────────────────────────────────────────────
// Frozen wording (asserted verbatim — both tiers)
// ──────────────────────────────────────────────

function cancelWording(toolName: string): string {
  return `Tool "${toolName}" was interrupted: the user cancelled the turn before it finished. The call was not judged either way.`;
}

function limitWording(toolName: string): string {
  return `Tool "${toolName}" was interrupted: the turn was terminated by a safety limit before it finished.`;
}

// ──────────────────────────────────────────────
// Shared assertion helper
// ──────────────────────────────────────────────

/**
 * Ids of assistant `tool_use` blocks with no `tool_result` of the same id in
 * the same history. The pairing property under test: this must be `[]` on
 * every termination path.
 */
export function unpairedToolUseIds(messages: Message[]): string[] {
  const paired = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) paired.add(b.toolUseId);
  }
  const unpaired: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.type === "tool_use" && !paired.has(b.id)) unpaired.push(b.id);
    }
  }
  return unpaired;
}

/** The tool_result block answering one tool-use id, if present. */
function resultBlockFor(messages: Message[], toolUseId: string): ToolResultContent | undefined {
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) {
      if (b.type === "tool_result" && b.toolUseId === toolUseId) return b;
    }
  }
  return undefined;
}

/** Concatenated text of one tool_result block. */
function resultTextFor(messages: Message[], toolUseId: string): string {
  const block = resultBlockFor(messages, toolUseId);
  return (block?.content ?? [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");
}

/** toolUseId of every tool_result message, in message order. */
function resultIdsInOrder(messages: Message[]): string[] {
  return messages
    .filter((m): m is Extract<Message, { role: "tool" }> => m.role === "tool")
    .flatMap((m) => m.content.map((b) => b.toolUseId));
}

// ──────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────

const tools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    requires: ["filesystem:read"],
    riskTier: "READ_ONLY",
  },
  {
    name: "search",
    description: "Search files",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    requires: ["filesystem:read"],
    riskTier: "READ_ONLY",
  },
  {
    name: "bash",
    description: "Run a shell command",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    requires: ["shell:exec"],
    riskTier: "WRITE_LOW",
  },
  {
    name: "edit_file",
    description: "Edit a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    requires: ["filesystem:write"],
    riskTier: "WRITE_HIGH",
  },
];

const ctx: StepContext = { tools, model: "test-model" };

/** Drive the reducer through a sequence of inputs. */
function drive(
  inputs: AgentInput[],
  stepCtx: StepContext,
  initial?: ReducerState,
): { trace: Array<{ state: ReducerState; effects: Effect[] }>; state: ReducerState } {
  const trace: Array<{ state: ReducerState; effects: Effect[] }> = [];
  let state = initial ?? createInitialState();
  for (const input of inputs) {
    const result = step(state, input, stepCtx);
    trace.push({ state: result.state, effects: result.effects });
    state = result.state;
  }
  return { trace, state };
}

/** One tool_use accumulation chunk. */
function toolUseDelta(toolCallId: string, toolCallName: string, args: string): AgentInput {
  return {
    type: "model_chunk",
    chunk: { type: "tool_use_delta", toolCallId, toolCallName, argumentsDelta: args },
  };
}

/** user_message → 3 tool_use (call_A read_file, call_B search, call_C bash) → executing_tools. */
function buildThreeToolSetup(): AgentInput[] {
  return [
    { type: "user_message", content: "Do three things" },
    toolUseDelta("call_A", "read_file", '{"path":"a.ts"}'),
    toolUseDelta("call_B", "search", '{"query":"hello"}'),
    toolUseDelta("call_C", "bash", '{"command":"echo hi"}'),
    { type: "model_done", stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } },
  ];
}

/** user_message → 2 tool_use (t1 edit_file, t2 read_file) → executing_tools. */
function buildMixedToolSetup(): AgentInput[] {
  return [
    { type: "user_message", content: "Edit and read" },
    toolUseDelta("t1", "edit_file", '{"path":"/a.ts"}'),
    toolUseDelta("t2", "read_file", '{"path":"/b.ts"}'),
    { type: "model_done", stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } },
  ];
}

/** A completed failed call pair (assistant tool_use + errored tool_result), for loop seeding. */
function failedToolPair(
  callId: string,
  name: string,
  input: Record<string, unknown>,
): Message[] {
  return [
    {
      id: `${callId}-assistant`,
      role: "assistant",
      content: [{ type: "tool_use", id: callId, name, input }],
      stopReason: "tool_use",
    },
    {
      id: `${callId}-result`,
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolUseId: callId,
          content: [{ type: "text", text: "boom" }],
          isError: true,
        },
      ],
    },
  ];
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("termination pairing — every roster-clearing path closes its tool_use blocks", () => {
  it("cancel in executing_tools pairs every pending tool_use", () => {
    const { state: executing } = drive(buildThreeToolSetup(), ctx);
    expect(executing.status).toBe("executing_tools");

    // One result has already arrived (buffered, never flushed) — it must be
    // KEPT as the real result; the two missing ones are synthesized.
    const withBuffered = step(
      executing,
      {
        type: "tool_result",
        toolCallId: "call_A",
        toolName: "read_file",
        result: { modelContent: "real output" },
      },
      ctx,
    ).state;

    const cancelled = step(withBuffered, { type: "cancel", reason: "user" }, ctx).state;
    expect(cancelled.status).toBe("cancelling");
    expect(cancelled.pendingTools).toEqual([]);

    // The pairing property: no un-paired tool_use survives the termination.
    expect(unpairedToolUseIds(cancelled.messages)).toEqual([]);

    // The buffered result keeps its real content, in roster order; the
    // missing ones carry the cancel tier's frozen wording, marked isError.
    expect(resultIdsInOrder(cancelled.messages)).toEqual(["call_A", "call_B", "call_C"]);
    expect(resultTextFor(cancelled.messages, "call_A")).toBe("real output");
    expect(resultBlockFor(cancelled.messages, "call_A")!.isError ?? false).toBe(false);
    expect(resultTextFor(cancelled.messages, "call_B")).toBe(cancelWording("search"));
    expect(resultBlockFor(cancelled.messages, "call_B")!.isError).toBe(true);
    expect(resultTextFor(cancelled.messages, "call_C")).toBe(cancelWording("bash"));
    expect(resultBlockFor(cancelled.messages, "call_C")!.isError).toBe(true);
  });

  it("cancel in waiting_for_approval also pairs the approval-pending call", () => {
    const { state: executing } = drive(buildMixedToolSetup(), ctx);
    const waiting = step(executing, { type: "request_approval", toolCallId: "t1" }, ctx).state;
    expect(waiting.status).toBe("waiting_for_approval");
    expect(waiting.pendingApprovalTool?.id).toBe("t1");

    const cancelled = step(waiting, { type: "cancel", reason: "user" }, ctx).state;
    expect(cancelled.status).toBe("cancelling");

    // Both the still-executing sibling and the approval-pending call pair —
    // the approval-pending call's name comes from its roster entry.
    expect(unpairedToolUseIds(cancelled.messages)).toEqual([]);
    expect(resultTextFor(cancelled.messages, "t2")).toBe(cancelWording("read_file"));
    expect(resultBlockFor(cancelled.messages, "t2")!.isError).toBe(true);
    expect(resultTextFor(cancelled.messages, "t1")).toBe(cancelWording("edit_file"));
    expect(resultBlockFor(cancelled.messages, "t1")!.isError).toBe(true);

    // The roster is fully cleared, so the cancelling → done hop cannot
    // synthesize a second time.
    expect(cancelled.pendingTools).toEqual([]);
    expect(cancelled.pendingApprovalTool).toBeUndefined();
  });

  it("budget_exceeded with a roster pairs every pending tool_use", () => {
    const { state: executing } = drive(buildThreeToolSetup(), ctx);

    const terminated = step(
      executing,
      { type: "budget_exceeded", reason: "Cost budget exceeded" },
      ctx,
    ).state;
    expect(terminated.status).toBe("done");
    expect(terminated.pendingTools).toEqual([]);

    expect(unpairedToolUseIds(terminated.messages)).toEqual([]);
    expect(resultIdsInOrder(terminated.messages)).toEqual(["call_A", "call_B", "call_C"]);
    expect(resultTextFor(terminated.messages, "call_A")).toBe(limitWording("read_file"));
    expect(resultTextFor(terminated.messages, "call_B")).toBe(limitWording("search"));
    expect(resultTextFor(terminated.messages, "call_C")).toBe(limitWording("bash"));
    for (const id of ["call_A", "call_B", "call_C"]) {
      expect(resultBlockFor(terminated.messages, id)!.isError).toBe(true);
    }
  });

  it("model_done tool_use hitting the iteration limit pairs the new calls", () => {
    // maxIterations: 1 — the first model_done already trips the runaway
    // guard, so the tool_use block it just wrote must be answered here.
    const initial = createInitialState({ maxIterations: 1 });
    const { trace, state } = drive(
      [
        { type: "user_message", content: "Go" },
        toolUseDelta("call_limit", "read_file", '{"path":"a.ts"}'),
        { type: "model_done", stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      ctx,
      initial,
    );

    expect(state.status).toBe("done");
    expect(state.pendingTools).toEqual([]);
    // The runaway guard still names the cap (guard intent unchanged).
    const lastEffects = trace[trace.length - 1]!.effects;
    expect(
      lastEffects.some(
        (e) => e.type === "emit" && e.event.type === "error" && e.event.data.error === "Maximum iterations reached",
      ),
    ).toBe(true);

    expect(unpairedToolUseIds(state.messages)).toEqual([]);
    expect(resultTextFor(state.messages, "call_limit")).toBe(limitWording("read_file"));
    expect(resultBlockFor(state.messages, "call_limit")!.isError).toBe(true);
  });

  it("loop hard-termination pairs every pending tool_use", () => {
    // K=2 with the intervention budget exhausted (0): the first >=K error
    // chain hard-terminates the turn (the pre-ladder behavior).
    const loopCtx: StepContext = { ...ctx, maxLoopCount: 2, maxLoopInterventions: 0 };
    const initial = createInitialState({
      messages: failedToolPair("loop-1", "bash", { command: "echo hi" }),
    });

    const { trace, state } = drive(
      [
        { type: "user_message", content: "Run echo" },
        toolUseDelta("loop-new", "bash", '{"command":"echo hi"}'),
        toolUseDelta("other-new", "read_file", '{"path":"a.ts"}'),
        { type: "model_done", stopReason: "tool_use" },
      ],
      loopCtx,
      initial,
    );

    expect(state.status).toBe("done");
    // The hard kill still reports its loop error (guard intent unchanged).
    const lastEffects = trace[trace.length - 1]!.effects;
    expect(
      lastEffects.some(
        (e) =>
          e.type === "emit" &&
          e.event.type === "error" &&
          e.event.data.error ===
            'Loop detected: tool "bash" has been called 2 times with identical input and returned errors',
      ),
    ).toBe(true);

    // The new calls the just-finalized assistant message carries are paired
    // even though none of them ever executed.
    expect(unpairedToolUseIds(state.messages)).toEqual([]);
    expect(resultTextFor(state.messages, "loop-new")).toBe(limitWording("bash"));
    expect(resultTextFor(state.messages, "other-new")).toBe(limitWording("read_file"));
    for (const id of ["loop-new", "other-new"]) {
      expect(resultBlockFor(state.messages, id)!.isError).toBe(true);
    }
  });

  it("the second cancel hop (cancelling -> done) does not double-synthesize", () => {
    const { state: executing } = drive(buildThreeToolSetup(), ctx);
    const afterFirstCancel = step(executing, { type: "cancel", reason: "user" }, ctx).state;
    expect(afterFirstCancel.status).toBe("cancelling");
    expect(unpairedToolUseIds(afterFirstCancel.messages)).toEqual([]);

    const afterSecondCancel = step(afterFirstCancel, { type: "cancel", reason: "user" }, ctx).state;
    expect(afterSecondCancel.status).toBe("done");

    // Idempotent: the roster was already empty, so the second hop adds
    // nothing — no duplicate results, message history unchanged.
    expect(afterSecondCancel.messages).toEqual(afterFirstCancel.messages);
    expect(resultIdsInOrder(afterSecondCancel.messages)).toEqual(["call_A", "call_B", "call_C"]);
    expect(unpairedToolUseIds(afterSecondCancel.messages)).toEqual([]);
  });
});
