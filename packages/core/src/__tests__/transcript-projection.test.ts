import { describe, it, expect } from "vitest";
import { projectMessages, projectMessageEntries } from "../transcript-projection.js";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { AgentInput } from "../input.js";
import type { AssistantMessage, ContentBlock, ImageContent, Message, ToolResultContent } from "../state.js";
import type { ToolDefinition } from "../tool.js";
import type { TranscriptEvent, TranscriptEventMap, TranscriptEventType, TokenUsage, Id } from "../index.js";

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
function driveAndRecord(
  inputs: AgentInput[],
  stepCtx: StepContext = ctx,
): { events: TranscriptEvent[]; finalState: ReducerState } {
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

    const result = step(state, input, stepCtx);
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
            ...(data.message.source !== undefined ? { source: data.message.source } : {}),
            ...(data.message.modelMeta !== undefined ? { modelMeta: data.message.modelMeta } : {}),
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
        case "compaction":
          push("compaction", event.data as TranscriptEventMap["compaction"]);
          break;
        case "tool_results_pruned":
          push("tool_results_pruned", event.data as TranscriptEventMap["tool_results_pruned"]);
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
 *
 * Also blanks message ids: transcript events do not yet carry the reducer's
 * stable message ids (write-back is a later task), so the projection
 * synthesizes `proj-N` while the reducer's ids come from StepContext.id.
 * Comparing them would pin this suite to two independent counters instead
 * of the ordering contract under test.
 */
function normalizeIsError(messages: Message[]): Message[] {
  return messages.map((m) =>
    m.role === "tool"
      ? { ...m, id: "", content: m.content.map((c: ToolResultContent) => ({ ...c, isError: c.isError ?? false })) }
      : { ...m, id: "" },
  );
}

/**
 * Drop message ids before deep-equality. Unit tests below assert ordering
 * and content, not identity — projection synthesizes `proj-N` deterministically
 * but those numbers are not the contract (stable reducer ids are a later
 * write-back task).
 */
function stripIds(messages: Message[]): Array<Omit<Message, "id">> {
  return messages.map(({ id: _ignored, ...rest }) => rest) as Array<Omit<Message, "id">>;
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
    expect((lastMsg.content as ToolResultContent[])[0]!.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("denied by the user") })]),
    );
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

  it("10. one tool denied while a sibling in the same batch is still executing", () => {
    // The Runner drains its approval queue before running the auto-allowed
    // parallel batch (runner.ts:788), so a batch mixing one "ask" tool with
    // one "allow" tool produces exactly this input order.
    const { events, finalState } = driveAndRecord([
      { type: "user_message", content: "go" },
      toolUseDelta("c1", "bash", '{"command":"rm -rf /"}'),
      toolUseDelta("c2", "read_file", '{"path":"a.ts"}'),
      { type: "model_done", stopReason: "tool_use" },
      { type: "request_approval", toolCallId: "c1" },
      { type: "approval_decision", toolCallId: "c1", decision: "deny" },
      { type: "tool_result", toolCallId: "c2", toolName: "read_file", result: { modelContent: "file contents" } },
    ]);

    // Both results must survive: an unanswered tool_use block makes the next
    // request malformed, and providers reject it outright.
    expect(finalState.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool"]);
    const toolIds = finalState.messages
      .filter((m): m is Extract<typeof m, { role: "tool" }> => m.role === "tool")
      .flatMap((m) => m.content.map((b) => b.toolUseId));
    expect(toolIds).toEqual(expect.arrayContaining(["c1", "c2"]));

    expect(normalizeIsError(projectMessages(events))).toEqual(normalizeIsError(finalState.messages));
  });

  it("11. compaction_applied replacing a mid-history tool batch", () => {
    // Align the reducer's Id port with the projection's proj-N counter so
    // replacedIds match on both sides. Exact id equality between the two
    // independent counters is still deferred for production logs (transcript
    // events do not yet carry reducer message ids); this test pins the
    // ordering contract under aligned ids.
    let n = 0;
    const idPort: Id = { next: () => `proj-${++n}` };
    const ctxWithId: StepContext = { tools, model: "test-model", id: idPort };

    const { events, finalState } = driveAndRecord(
      [
        { type: "user_message", content: "go" },
        toolUseDelta("c1", "read_file", '{"path":"a.ts"}'),
        { type: "model_done", stopReason: "tool_use" },
        { type: "tool_result", toolCallId: "c1", toolName: "read_file", result: { modelContent: "file contents" } },
        { type: "model_chunk", chunk: { type: "text_delta", text: "done" } },
        { type: "model_done", stopReason: "end_turn" },
        {
          type: "compaction_applied",
          summaryId: "sum-1",
          summaryText: "checkpoint",
          // user=proj-1, assistant(tool_use)=proj-2, tool=proj-3, assistant=proj-4.
          // Replace the tool batch (assistant + tool result), keep user + final reply.
          replacedIds: ["proj-2", "proj-3"],
        },
      ],
      ctxWithId,
    );

    expect(finalState.messages.map((m) => m.id)).toEqual(["proj-1", "sum-1", "proj-4"]);
    expect(projectMessages(events).map((m) => m.id)).toEqual(["proj-1", "sum-1", "proj-4"]);
    expect(normalizeIsError(projectMessages(events))).toEqual(normalizeIsError(finalState.messages));
    const sum = finalState.messages.find((m) => m.id === "sum-1")!;
    expect(String(sum.content)).toContain("[Earlier conversation summary]");
    expect(String(sum.content)).toContain("checkpoint");
  });

  it("12. compaction_applied with preserved images — projection carrier position matches the reducer", () => {
    // Consistency pin: the projection's carrier rule must match the
    // reducer's message-id sequence exactly, not just "a carrier appears".
    // Same aligned-id harness as test 11, now with preservedImages so the
    // emitted compaction event carries the ref metadata (D5 v1.2).
    let n = 0;
    const idPort: Id = { next: () => `proj-${++n}` };
    const ctxWithId: StepContext = { tools, model: "test-model", id: idPort };

    const img: ImageContent = {
      type: "image",
      source: { type: "ref", id: "att-9", mediaType: "image/png" },
      width: 640,
      height: 480,
    };

    const { events, finalState } = driveAndRecord(
      [
        { type: "user_message", content: "go" },
        toolUseDelta("c1", "read_file", '{"path":"a.ts"}'),
        { type: "model_done", stopReason: "tool_use" },
        { type: "tool_result", toolCallId: "c1", toolName: "read_file", result: { modelContent: "file contents" } },
        { type: "model_chunk", chunk: { type: "text_delta", text: "done" } },
        { type: "model_done", stopReason: "end_turn" },
        {
          type: "compaction_applied",
          summaryId: "sum-1",
          summaryText: "checkpoint",
          // user=proj-1, assistant(tool_use)=proj-2, tool=proj-3, assistant=proj-4.
          replacedIds: ["proj-2", "proj-3"],
          preservedImages: [img] as ContentBlock[],
        },
      ],
      ctxWithId,
    );

    // Reducer: summary at the earliest replaced position, carrier at +1.
    expect(finalState.messages.map((m) => m.id)).toEqual([
      "proj-1",
      "sum-1",
      "sum-1-images",
      "proj-4",
    ]);
    // Projection: same id sequence — the position rules agree.
    expect(projectMessages(events).map((m) => m.id)).toEqual([
      "proj-1",
      "sum-1",
      "sum-1-images",
      "proj-4",
    ]);
    expect(normalizeIsError(projectMessages(events))).toEqual(normalizeIsError(finalState.messages));

    // The projected carrier content is byte-identical to the reducer's:
    // markers rendered from the event's ref metadata, image refs intact.
    const reducerCarrier = finalState.messages.find((m) => m.id === "sum-1-images")!;
    const projectedCarrier = projectMessages(events).find((m) => m.id === "sum-1-images")!;
    expect(projectedCarrier.content).toEqual(reducerCarrier.content);
    expect(projectedCarrier.content).toEqual([
      { type: "text", text: "[image preserved from compressed conversation: 640x480 image/png]" },
      img as unknown as ContentBlock,
    ]);
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
      { id: "", role: "user", content: "hi" },
      { id: "", role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "end_turn" },
    ];
    expect(stripIds(projectMessages(events))).toEqual(stripIds(expected));
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
    expect(stripIds(messages.slice(2))).toEqual([
      { role: "tool", content: [{ type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "text" }], isError: false }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "c2", content: [{ type: "text", text: "a,b" }], isError: false }] },
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
      { time: 4, type: "steering_queued", data: { id: "steer-1", content: "actually wait" }, turn: 1, step: 1 },
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
    expect(stripIds(messages.slice(2))).toEqual([
      { role: "tool", content: [{ type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "text" }], isError: false }] },
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

    expect(stripIds(projectMessages(events))).toEqual([
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

    expect(stripIds([projectMessages(events).at(-1)!])[0]).toEqual({
      role: "tool",
      content: [{ type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "boom" }], isError: true }],
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
    expect(stripIds(projectMessages(events))).toEqual([
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

    expect(stripIds(projectMessages(events).slice(2))).toEqual([
      { role: "tool", content: [{ type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "second" }], isError: false }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "c2", content: [{ type: "text", text: "a,b" }], isError: false }] },
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
    expect(stripIds(projectMessages([]))).toEqual([]);
  });
});

describe("projectMessages — compaction write-back", () => {
  it("replaces the named span with a summary at the earliest replaced position", () => {
    const events = log([
      { time: 1, type: "user_message", data: { content: "old1" }, turn: 1 },
      {
        time: 2,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "reply1" }], stopReason: "end_turn", durationMs: 1 },
        turn: 1,
        step: 1,
      },
      { time: 3, type: "user_message", data: { content: "old2" }, turn: 2 },
      {
        time: 4,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "reply2" }], stopReason: "end_turn", durationMs: 1 },
        turn: 2,
        step: 1,
      },
      { time: 5, type: "user_message", data: { content: "recent" }, turn: 3 },
      {
        time: 6,
        type: "compaction",
        data: {
          replacedCount: 2,
          summaryText: "checkpoint",
          replacedIds: ["proj-1", "proj-2"],
          summaryId: "sum-1",
        },
        turn: 3,
      },
    ]);

    // proj-1..proj-4 are the four messages; compaction removes proj-1 and
    // proj-2, inserting sum-1 at their earliest position (index 0 of kept).
    const result = projectMessages(events);
    expect(result.map((m) => ({ id: m.id, role: m.role }))).toEqual([
      { id: "sum-1", role: "user" },
      { id: "proj-3", role: "user" },
      { id: "proj-4", role: "assistant" },
      { id: "proj-5", role: "user" },
    ]);
    const sum = result.find((m) => m.id === "sum-1")!;
    expect(String(sum.content)).toBe("[Earlier conversation summary]\ncheckpoint");
  });

  it("leaves the projection unchanged when no replaced id matches", () => {
    const events = log([
      { time: 1, type: "user_message", data: { content: "hi" }, turn: 1 },
      {
        time: 2,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "hello" }], stopReason: "end_turn", durationMs: 1 },
        turn: 1,
        step: 1,
      },
      {
        time: 3,
        type: "compaction",
        data: {
          replacedCount: 1,
          summaryText: "s",
          // None of these ids appear in the projected list — production logs
          // always hit this, since transcript events lack message ids.
          replacedIds: ["ghost", "also-missing"],
          summaryId: "sum-1",
        },
        turn: 1,
      },
    ]);

    // Unmatched replacedIds must SKIP like a legacy event: no insert, no remove.
    expect(stripIds(projectMessages(events))).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "end_turn" },
    ]);
  });

  it("replaces a non-contiguous span keeping the interleaved message", () => {
    const events = log([
      { time: 1, type: "user_message", data: { content: "a" }, turn: 1 },
      {
        time: 2,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "b" }], stopReason: "end_turn", durationMs: 1 },
        turn: 1,
        step: 1,
      },
      { time: 3, type: "user_message", data: { content: "c" }, turn: 2 },
      {
        time: 4,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "d" }], stopReason: "end_turn", durationMs: 1 },
        turn: 2,
        step: 1,
      },
      {
        time: 5,
        type: "compaction",
        data: {
          replacedCount: 2,
          summaryText: "s",
          // Replace proj-1 and proj-3, keep the interleaved proj-2.
          replacedIds: ["proj-1", "proj-3"],
          summaryId: "sum-1",
        },
        turn: 2,
      },
    ]);

    // kept = [proj-2, proj-4]; firstIdx = 0 → insertAt = 0.
    expect(projectMessages(events).map((m) => m.id)).toEqual(["sum-1", "proj-2", "proj-4"]);
  });

  it("still ignores legacy compaction events without replacedIds/summaryId", () => {
    const events = log([
      { time: 1, type: "user_message", data: { content: "hi" }, turn: 1 },
      // Pre-write-back compaction: records that compaction happened on the
      // request surface, but carries no ids to replay a state rewrite.
      { time: 2, type: "compaction", data: { replacedCount: 3, summaryText: "..." }, turn: 1 },
      {
        time: 3,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "hello" }], stopReason: "end_turn", durationMs: 1 },
        turn: 1,
        step: 1,
      },
    ]);

    expect(stripIds(projectMessages(events))).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "end_turn" },
    ]);
  });

  it("inserts the images carrier right after the summary when the event carries preservedImages", () => {
    const events = log([
      { time: 1, type: "user_message", data: { content: "old1" }, turn: 1 },
      {
        time: 2,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "reply1" }], stopReason: "end_turn", durationMs: 1 },
        turn: 1,
        step: 1,
      },
      { time: 3, type: "user_message", data: { content: "old2" }, turn: 2 },
      {
        time: 4,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "reply2" }], stopReason: "end_turn", durationMs: 1 },
        turn: 2,
        step: 1,
      },
      { time: 5, type: "user_message", data: { content: "recent" }, turn: 3 },
      {
        time: 6,
        type: "compaction",
        data: {
          replacedCount: 2,
          summaryText: "checkpoint",
          replacedIds: ["proj-1", "proj-2"],
          summaryId: "sum-1",
          // Ref METADATA only — the reducer never puts bytes on the event;
          // the marker text is re-rendered here from dims + mediaType.
          preservedImages: [
            { id: "att-1", mediaType: "image/png", width: 800, height: 600 },
            { id: "att-2", mediaType: "image/jpeg" },
          ],
        },
        turn: 3,
      },
    ]);

    const result = projectMessages(events);
    // Same position rule as the reducer's compaction_applied handler: the
    // carrier (`${summaryId}-images`, user role) sits at summary + 1.
    expect(result.map((m) => ({ id: m.id, role: m.role }))).toEqual([
      { id: "sum-1", role: "user" },
      { id: "sum-1-images", role: "user" },
      { id: "proj-3", role: "user" },
      { id: "proj-4", role: "assistant" },
      { id: "proj-5", role: "user" },
    ]);

    // Carrier content: [marker, image ref] pairs, markers verbatim (same
    // bytes the reducer would render for these dims / mediaType).
    const carrier = result.find((m) => m.id === "sum-1-images")!;
    expect(carrier.content).toEqual([
      { type: "text", text: "[image preserved from compressed conversation: 800x600 image/png]" },
      { type: "image", source: { type: "ref", id: "att-1", mediaType: "image/png" }, width: 800, height: 600 },
      { type: "text", text: "[image preserved from compressed conversation: image/jpeg]" },
      { type: "image", source: { type: "ref", id: "att-2", mediaType: "image/jpeg" } },
    ]);
  });

  it("replays an old compaction event without preservedImages byte-identically (no carrier)", () => {
    const events = log([
      { time: 1, type: "user_message", data: { content: "old1" }, turn: 1 },
      {
        time: 2,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "reply1" }], stopReason: "end_turn", durationMs: 1 },
        turn: 1,
        step: 1,
      },
      { time: 3, type: "user_message", data: { content: "recent" }, turn: 2 },
      {
        time: 4,
        type: "compaction",
        data: {
          replacedCount: 1,
          summaryText: "checkpoint",
          replacedIds: ["proj-1"],
          summaryId: "sum-1",
          // No preservedImages — a pre-carrier event. The projection must
          // insert ONLY the summary, exactly as before this feature.
        },
        turn: 2,
      },
    ]);

    const result = projectMessages(events);
    expect(result.map((m) => ({ id: m.id, role: m.role }))).toEqual([
      { id: "sum-1", role: "user" },
      { id: "proj-2", role: "assistant" },
      { id: "proj-3", role: "user" },
    ]);
    const sum = result.find((m) => m.id === "sum-1")!;
    expect(sum.content).toBe("[Earlier conversation summary]\ncheckpoint");
    expect(result.some((m) => m.id === "sum-1-images")).toBe(false);
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

    expect(projectMessageEntries(events).map((e) => ({ ...e, message: stripIds([e.message])[0]! }))).toEqual([
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
      { time: 30, type: "steering_queued", data: { id: "steer-1", content: "wait" }, turn: 1, step: 1 },
      {
        time: 40,
        type: "tool_result",
        data: { callId: "c1", name: "read_file", content: "text", isError: false, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
    ]);

    const entries = projectMessageEntries(events);
    expect(stripIds(entries.map((e) => e.message))).toEqual(stripIds(projectMessages(events)));
    // Steering sits after the tool result, so its time runs backwards here —
    // that is correct: position follows the reducer, not the clock.
    expect(entries.map((e) => e.time)).toEqual([10, 20, 40, 30]);
  });
});
