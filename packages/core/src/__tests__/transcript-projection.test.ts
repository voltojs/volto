import { describe, it, expect } from "vitest";
import { projectMessages, projectMessageEntries } from "../transcript-projection.js";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { AgentInput } from "../input.js";
import type { AssistantMessage, Message, ToolResultContent } from "../state.js";
import type { ToolDefinition } from "../tool.js";
import type { TranscriptEvent, TranscriptEventMap, TranscriptEventType, TokenUsage } from "../index.js";

/** Builds a stored event; seq is assigned in array order by the helper below. */
function log(
  entries: Array<Omit<TranscriptEvent, "seq">>,
): TranscriptEvent[] {
  return entries.map((e, i) => ({ ...e, seq: i }) as TranscriptEvent);
}

// ──────────────────────────────────────────────────────────────────────────
// Differential harness — the actual correctness gate.
//
// Fix round 1 review found that all of the hand-written tests below are
// literals: none of them drove the real reducer, so three real ordering
// defects (calling_model-phase steering, denied tools, cancelled batches)
// survived. This harness drives step() from the core reducer for real,
// converts its `emit` effects into TranscriptEvent[] the way Task 7's Runner
// will, and asserts projectMessages(events) reproduces state.messages
// exactly — no literal expectations to drift out of sync with the reducer.
// ──────────────────────────────────────────────────────────────────────────

const tools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    requires: ["filesystem:read"],
    riskTier: "READ_ONLY",
  },
  {
    name: "list_dir",
    description: "List a directory",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    requires: ["filesystem:read"],
    riskTier: "READ_ONLY",
  },
  {
    name: "bash",
    description: "Run a shell command",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    requires: ["shell:exec"],
    riskTier: "WRITE_HIGH",
  },
];

const ctx: StepContext = { tools, model: "test-model" };

/** Starts a tool_use accumulation for one call in the current model turn. */
function toolUseDelta(toolCallId: string, toolCallName: string, args: string): AgentInput {
  return {
    type: "model_chunk",
    chunk: { type: "tool_use_delta", toolCallId, toolCallName, argumentsDelta: args },
  };
}

/**
 * Drives a sequence of AgentInputs through the real reducer and records a
 * TranscriptEvent[] the way Task 7's Runner will:
 *  - `model_done`'s emitted `message` -> an `assistant_message` event.
 *  - `tool_result`'s emit -> a `tool_result` event (`toolCallId` renamed to
 *    `callId`, `content` / `displayMetadata` / `orderInBatch` passed through).
 *  - `steering_queued` / `user_message` emits -> pass through unchanged.
 *  - the `request_approval` effect -> an `approval_asked` event (this is not
 *    an `emit` effect, but the Runner logs it when it asks the ApprovalGate).
 *  - an `approval_decision` INPUT -> the Runner logs this event itself before
 *    feeding the decision back to step() — the reducer's own deny/allow
 *    transition never emits one (see fix-round-1 finding 2).
 *  - a `cancelled` emit -> a `turn_end` event with reason "cancelled" (a
 *    log-only event either way; recorded for realism, not correctness).
 * Streaming-only signals (text_delta, tool_use_delta, tool_use_complete,
 * reasoning_delta) are not persisted, matching real transcript granularity.
 */
function driveAndRecord(inputs: AgentInput[]): { events: TranscriptEvent[]; finalState: ReducerState } {
  let state: ReducerState = createInitialState();
  const events: TranscriptEvent[] = [];
  let seq = 0;
  let time = 0;

  function push<T extends TranscriptEventType>(type: T, data: TranscriptEventMap[T]): void {
    events.push({ seq: seq++, time: time++, type, data, turn: 1 } as TranscriptEvent);
  }

  for (const input of inputs) {
    if (input.type === "approval_decision") {
      push("approval_decision", { callId: input.toolCallId, decision: input.decision });
    }

    const result = step(state, input, ctx);
    state = result.state;

    for (const effect of result.effects) {
      if (effect.type === "request_approval") {
        push("approval_asked", {
          callId: effect.toolCall.id,
          name: effect.toolCall.name,
          riskTier: effect.riskTier,
        });
        continue;
      }
      if (effect.type !== "emit") continue;

      const { event } = effect;
      switch (event.type) {
        case "user_message":
          push("user_message", event.data as TranscriptEventMap["user_message"]);
          break;
        case "steering_queued":
          push("steering_queued", event.data as TranscriptEventMap["steering_queued"]);
          break;
        case "model_done": {
          const data = event.data as { stopReason?: AssistantMessage["stopReason"]; usage?: TokenUsage; message: AssistantMessage };
          push("assistant_message", {
            content: data.message.content,
            stopReason: data.message.stopReason,
            usage: data.usage,
            // The reducer does not track per-call wall-clock duration; the
            // projection never reads durationMs, so a fixed value is fine.
            durationMs: 0,
          });
          break;
        }
        case "tool_result": {
          const data = event.data as {
            toolCallId: string;
            toolName?: string;
            isError: boolean;
            durationMs?: number;
            content: string;
            displayMetadata?: Record<string, unknown>;
            orderInBatch: number;
          };
          push("tool_result", {
            callId: data.toolCallId,
            name: data.toolName,
            content: data.content,
            isError: data.isError,
            durationMs: data.durationMs,
            displayMetadata: data.displayMetadata,
            orderInBatch: data.orderInBatch,
          });
          break;
        }
        case "cancelled":
          push("turn_end", { turn: 1, reason: "cancelled" });
          break;
        default:
          break; // streaming-only signal — not persisted
      }
    }
  }

  return { events, finalState: state };
}

/**
 * Normalizes `isError` on tool-result content before deep-equality. Every
 * `tool_result` TranscriptEvent coerces `isError` to a boolean (`?? false`,
 * reducer.ts:527) since the event schema requires one, but the reducer's own
 * `state.messages` carries `input.result.isError` verbatim — `undefined` when
 * a tool didn't set it. The two are semantically equivalent; normalize
 * instead of weakening the assertion.
 */
function normalizeIsError(messages: Message[]): Message[] {
  return messages.map((m) =>
    m.role === "tool"
      ? { ...m, content: m.content.map((c: ToolResultContent) => ({ ...c, isError: c.isError ?? false })) }
      : m,
  );
}

describe("projectMessages ~ reducer equivalence (differential)", () => {
  it("1. single tool, sequential", () => {
    const { events, finalState } = driveAndRecord([
      { type: "user_message", content: "go" },
      toolUseDelta("c1", "read_file", '{"path":"a.ts"}'),
      { type: "model_done", stopReason: "tool_use" },
      { type: "tool_result", toolCallId: "c1", toolName: "read_file", result: { modelContent: "file contents" } },
    ]);

    expect(normalizeIsError(projectMessages(events))).toEqual(normalizeIsError(finalState.messages));
  });

  it("2. two parallel tools where the second reports first", () => {
    const { events, finalState } = driveAndRecord([
      { type: "user_message", content: "go" },
      toolUseDelta("c1", "read_file", '{"path":"a.ts"}'),
      toolUseDelta("c2", "list_dir", '{"path":"."}'),
      { type: "model_done", stopReason: "tool_use" },
      { type: "tool_result", toolCallId: "c2", toolName: "list_dir", result: { modelContent: "a,b" } },
      { type: "tool_result", toolCallId: "c1", toolName: "read_file", result: { modelContent: "file contents" } },
    ]);

    expect(normalizeIsError(projectMessages(events))).toEqual(normalizeIsError(finalState.messages));
    // Guard the interesting property directly, not just via equivalence.
    const toolMsgs = finalState.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => (m.content as ToolResultContent[])[0]!.toolUseId)).toEqual(["c1", "c2"]);
  });

  it("3. steering injected during executing_tools", () => {
    const { events, finalState } = driveAndRecord([
      { type: "user_message", content: "go" },
      toolUseDelta("c1", "read_file", '{"path":"a.ts"}'),
      { type: "model_done", stopReason: "tool_use" },
      { type: "user_message", content: "wait" }, // steering: status is executing_tools
      { type: "tool_result", toolCallId: "c1", toolName: "read_file", result: { modelContent: "file contents" } },
    ]);

    expect(normalizeIsError(projectMessages(events))).toEqual(normalizeIsError(finalState.messages));
  });

  it("4. steering injected during calling_model", () => {
    const { events, finalState } = driveAndRecord([
      { type: "user_message", content: "go" },
      { type: "user_message", content: "wait" }, // steering: status is calling_model
      toolUseDelta("c1", "read_file", '{"path":"a.ts"}'),
      { type: "model_done", stopReason: "tool_use" },
      { type: "tool_result", toolCallId: "c1", toolName: "read_file", result: { modelContent: "file contents" } },
    ]);

    expect(normalizeIsError(projectMessages(events))).toEqual(normalizeIsError(finalState.messages));
    // The steering event has a smaller seq than the batch's tool_result, yet
    // must still land after it — the defect fix-round-1 flagged as Critical 1.
    expect(finalState.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
  });

  it("5. a turn ends end_turn with an unflushed steering queue", () => {
    const { events, finalState } = driveAndRecord([
      { type: "user_message", content: "go" },
      { type: "user_message", content: "wait" }, // steering: status is calling_model
      { type: "model_chunk", chunk: { type: "text_delta", text: "hello" } },
      { type: "model_done", stopReason: "end_turn" },
    ]);

    // resetTurnForNextInput would discard queuedUserInputs before the next
    // turn — the reducer never flushes it into messages on its own.
    expect(finalState.queuedUserInputs).toHaveLength(1);
    expect(normalizeIsError(projectMessages(events))).toEqual(normalizeIsError(finalState.messages));
    expect(finalState.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("6. a denied tool call", () => {
    const { events, finalState } = driveAndRecord([
      { type: "user_message", content: "go" },
      toolUseDelta("c1", "bash", '{"command":"rm -rf /"}'),
      { type: "model_done", stopReason: "tool_use" },
      { type: "request_approval", toolCallId: "c1" },
      { type: "approval_decision", toolCallId: "c1", decision: "deny" },
    ]);

    expect(normalizeIsError(projectMessages(events))).toEqual(normalizeIsError(finalState.messages));
    const lastMsg = finalState.messages.at(-1)!;
    expect(lastMsg.role).toBe("tool");
    expect((lastMsg.content as ToolResultContent[])[0]!.content).toContain("denied by the user");
  });

  it("7. a cancel with a partially-reported batch", () => {
    const { events, finalState } = driveAndRecord([
      { type: "user_message", content: "go" },
      toolUseDelta("c1", "read_file", '{"path":"a.ts"}'),
      toolUseDelta("c2", "list_dir", '{"path":"."}'),
      { type: "model_done", stopReason: "tool_use" },
      { type: "tool_result", toolCallId: "c1", toolName: "read_file", result: { modelContent: "file contents" } },
      { type: "cancel", reason: "user" },
    ]);

    // The reducer clears _toolResultBuffer on cancel without ever flushing
    // it — c1's already-arrived result must not appear in history.
    expect(finalState.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(normalizeIsError(projectMessages(events))).toEqual(normalizeIsError(finalState.messages));
  });

  it("8. two consecutive tool batches in one turn", () => {
    const { events, finalState } = driveAndRecord([
      { type: "user_message", content: "go" },
      toolUseDelta("c1", "read_file", '{"path":"a.ts"}'),
      { type: "model_done", stopReason: "tool_use" },
      { type: "tool_result", toolCallId: "c1", toolName: "read_file", result: { modelContent: "file contents" } },
      toolUseDelta("c2", "list_dir", '{"path":"."}'),
      { type: "model_done", stopReason: "tool_use" },
      { type: "tool_result", toolCallId: "c2", toolName: "list_dir", result: { modelContent: "a,b" } },
    ]);

    expect(normalizeIsError(projectMessages(events))).toEqual(normalizeIsError(finalState.messages));
    expect(finalState.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
  });

  it("9. a tool returning isError: true", () => {
    const { events, finalState } = driveAndRecord([
      { type: "user_message", content: "go" },
      toolUseDelta("c1", "bash", '{"command":"false"}'),
      { type: "model_done", stopReason: "tool_use" },
      { type: "tool_result", toolCallId: "c1", toolName: "bash", result: { modelContent: "boom", isError: true } },
    ]);

    expect(normalizeIsError(projectMessages(events))).toEqual(normalizeIsError(finalState.messages));
    const lastMsg = finalState.messages.at(-1)!;
    expect((lastMsg.content as ToolResultContent[])[0]!.isError).toBe(true);
  });
});

describe("projectMessages", () => {
  it("projects a plain user → assistant exchange", () => {
    const events = log([
      { time: 1, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 2, type: "user_message", data: { content: "hi" }, turn: 1 },
      {
        time: 3,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "hello" }], stopReason: "end_turn", durationMs: 10 },
        turn: 1,
        step: 1,
      },
      { time: 4, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
    ]);

    const expected: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "end_turn" },
    ];
    expect(projectMessages(events)).toEqual(expected);
  });

  it("orders parallel tool results by orderInBatch, not by arrival", () => {
    const events = log([
      { time: 1, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 2, type: "user_message", data: { content: "go" }, turn: 1 },
      {
        time: 3,
        type: "assistant_message",
        data: {
          content: [
            { type: "tool_use", id: "c1", name: "read_file", input: {} },
            { type: "tool_use", id: "c2", name: "list_dir", input: {} },
          ],
          stopReason: "tool_use",
          durationMs: 10,
        },
        turn: 1,
        step: 1,
      },
      // c2 finishes FIRST but is index 1 in the batch.
      {
        time: 4,
        type: "tool_result",
        data: { callId: "c2", name: "list_dir", content: "a,b", isError: false, orderInBatch: 1 },
        turn: 1,
        step: 1,
      },
      {
        time: 5,
        type: "tool_result",
        data: { callId: "c1", name: "read_file", content: "text", isError: false, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
    ]);

    const messages = projectMessages(events);
    expect(messages.slice(2)).toEqual([
      { role: "tool", content: [{ type: "tool_result", toolUseId: "c1", content: "text", isError: false }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "c2", content: "a,b", isError: false }] },
    ]);
  });

  it("places a steering message after the batch's tool results, not at its own seq", () => {
    const events = log([
      { time: 1, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 2, type: "user_message", data: { content: "go" }, turn: 1 },
      {
        time: 3,
        type: "assistant_message",
        data: {
          content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }],
          stopReason: "tool_use",
          durationMs: 10,
        },
        turn: 1,
        step: 1,
      },
      // Steering arrives DURING tool execution — lower seq than the result.
      { time: 4, type: "steering_queued", data: { content: "actually wait" }, turn: 1, step: 1 },
      {
        time: 5,
        type: "tool_result",
        data: { callId: "c1", name: "read_file", content: "text", isError: false, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
    ]);

    const messages = projectMessages(events);
    // The reducer flushes [...tool results, ...queuedUserInputs] — the steering
    // message lands AFTER the tool result despite having the smaller seq.
    expect(messages.slice(2)).toEqual([
      { role: "tool", content: [{ type: "tool_result", toolUseId: "c1", content: "text", isError: false }] },
      { role: "user", content: "actually wait" },
    ]);
  });

  it("ignores compaction, request_header and other log-only events", () => {
    const events = log([
      { time: 1, type: "turn_start", data: { turn: 1 }, turn: 1 },
      {
        time: 2,
        type: "request_header",
        data: { hash: "abc", systemLayers: [], tools: [], params: {} },
        turn: 1,
      },
      { time: 3, type: "user_message", data: { content: "hi" }, turn: 1 },
      { time: 4, type: "compaction", data: { replacedCount: 3, summaryText: "..." }, turn: 1 },
      { time: 5, type: "model_call_start", data: { headerHash: "abc" }, turn: 1, step: 1 },
      { time: 6, type: "context_assembled", data: { layerOrigins: [] }, turn: 1, step: 1 },
      {
        time: 7,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "hello" }], stopReason: "end_turn", durationMs: 10 },
        turn: 1,
        step: 1,
      },
    ]);

    expect(projectMessages(events)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "end_turn" },
    ]);
  });

  it("keeps an errored tool result in history with isError set", () => {
    const events = log([
      { time: 1, type: "user_message", data: { content: "go" }, turn: 1 },
      {
        time: 2,
        type: "assistant_message",
        data: {
          content: [{ type: "tool_use", id: "c1", name: "bash", input: {} }],
          stopReason: "tool_use",
          durationMs: 5,
        },
        turn: 1,
        step: 1,
      },
      {
        time: 3,
        type: "tool_result",
        data: { callId: "c1", name: "bash", content: "boom", isError: true, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
    ]);

    expect(projectMessages(events).at(-1)).toEqual({
      role: "tool",
      content: [{ type: "tool_result", toolUseId: "c1", content: "boom", isError: true }],
    });
  });

  it("drops an unmatched tool_result (orderInBatch: -1) instead of sorting it to the front", () => {
    // matchingIndex === -1 (reducer.ts:518) means the id was no longer in
    // pendingTools when the result arrived — pendingTools.map(...) at flush
    // time can never pick it up, so the projection must not either.
    const events = log([
      { time: 1, type: "user_message", data: { content: "go" }, turn: 1 },
      {
        time: 2,
        type: "assistant_message",
        data: {
          content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }],
          stopReason: "tool_use",
          durationMs: 5,
        },
        turn: 1,
        step: 1,
      },
      // A stray/late result for an id the batch never expected to still be
      // waiting on — orderInBatch: -1 signals "not found in pendingTools".
      {
        time: 3,
        type: "tool_result",
        data: { callId: "c1", name: "read_file", content: "stale", isError: false, orderInBatch: -1 },
        turn: 1,
        step: 1,
      },
    ]);

    // The batch never completes (its one entry was dropped, not resolved),
    // so nothing after the assistant message is emitted.
    expect(projectMessages(events)).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }],
        stopReason: "tool_use",
      },
    ]);
  });

  it("keeps only the last result for a duplicate callId", () => {
    // Mirrors the reducer's id-keyed buffer (reducer.ts:513): a second
    // tool_result for the same id overwrites the first rather than
    // appending a second message. c1 is duplicated WHILE the batch is still
    // waiting on c2, so the overwrite happens before the batch flushes —
    // if it instead completed (and flushed) on the first c1 report, this
    // test wouldn't exercise the overwrite path at all.
    const events = log([
      { time: 1, type: "user_message", data: { content: "go" }, turn: 1 },
      {
        time: 2,
        type: "assistant_message",
        data: {
          content: [
            { type: "tool_use", id: "c1", name: "read_file", input: {} },
            { type: "tool_use", id: "c2", name: "list_dir", input: {} },
          ],
          stopReason: "tool_use",
          durationMs: 5,
        },
        turn: 1,
        step: 1,
      },
      {
        time: 3,
        type: "tool_result",
        data: { callId: "c1", name: "read_file", content: "first", isError: false, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
      {
        time: 4,
        type: "tool_result",
        data: { callId: "c1", name: "read_file", content: "second", isError: false, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
      {
        time: 5,
        type: "tool_result",
        data: { callId: "c2", name: "list_dir", content: "a,b", isError: false, orderInBatch: 1 },
        turn: 1,
        step: 1,
      },
    ]);

    expect(projectMessages(events).slice(2)).toEqual([
      { role: "tool", content: [{ type: "tool_result", toolUseId: "c1", content: "second", isError: false }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "c2", content: "a,b", isError: false }] },
    ]);
  });

  it("accumulates across turns", () => {
    const events = log([
      { time: 1, type: "user_message", data: { content: "one" }, turn: 1 },
      {
        time: 2,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "1" }], stopReason: "end_turn", durationMs: 1 },
        turn: 1,
        step: 1,
      },
      { time: 3, type: "user_message", data: { content: "two" }, turn: 2 },
      {
        time: 4,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "2" }], stopReason: "end_turn", durationMs: 1 },
        turn: 2,
        step: 1,
      },
    ]);

    expect(projectMessages(events).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("returns an empty array for an empty log", () => {
    expect(projectMessages([])).toEqual([]);
  });
});

describe("projectMessageEntries", () => {
  it("pairs each projected message with the time of the event that produced it", () => {
    const events = log([
      { time: 10, type: "user_message", data: { content: "hi" }, turn: 1 },
      {
        time: 20,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "hello" }], stopReason: "end_turn", durationMs: 5 },
        turn: 1,
        step: 1,
      },
    ]);

    expect(projectMessageEntries(events)).toEqual([
      { message: { role: "user", content: "hi" }, time: 10 },
      {
        message: { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "end_turn" },
        time: 20,
      },
    ]);
  });

  it("stays aligned with projectMessages under steering reordering", () => {
    const events = log([
      { time: 10, type: "user_message", data: { content: "go" }, turn: 1 },
      {
        time: 20,
        type: "assistant_message",
        data: {
          content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }],
          stopReason: "tool_use",
          durationMs: 5,
        },
        turn: 1,
        step: 1,
      },
      { time: 30, type: "steering_queued", data: { content: "wait" }, turn: 1, step: 1 },
      {
        time: 40,
        type: "tool_result",
        data: { callId: "c1", name: "read_file", content: "text", isError: false, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
    ]);

    const entries = projectMessageEntries(events);
    expect(entries.map((e) => e.message)).toEqual(projectMessages(events));
    // Steering sits after the tool result, so its time runs backwards here —
    // that is correct: position follows the reducer, not the clock.
    expect(entries.map((e) => e.time)).toEqual([10, 20, 40, 30]);
  });
});
