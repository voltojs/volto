import { describe, it, expect } from "vitest";
import { projectMessages, projectMessageEntries } from "../transcript-projection.js";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { AgentInput } from "../input.js";
import type { AssistantMessage, ContentBlock, ImageContent, Message, ToolResultBlock, ToolResultContent } from "../state.js";
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
 *  - `steering_queued` / `steering_delivered` / `steering_edited` /
 *    `steering_removed` / `user_message` emits -> pass through unchanged.
 *  - the `request_approval` effect -> an `approval_asked` event (this is not
 *    an `emit` effect, but the Runner logs it when it asks the ApprovalGate).
 *  - an `approval_decision` INPUT -> the Runner logs this event itself before
 *    feeding the decision back to step() — the reducer's own deny/allow
 *    transition never emits one (see fix-round-1 finding 2).
 *  - a `cancelled` emit -> a `turn_end` event with reason "cancelled". This
 *    is the projection's termination-pairing trigger (not log-only): the
 *    real Runner derives one `turn_end` at end-of-run for EVERY termination
 *    (done / error / cancelled / budget_exceeded, runner.ts recordTurnEnd);
 *    the harness only needs it for the cancel paths exercised below.
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
        case "steering_delivered":
          push("steering_delivered", event.data as TranscriptEventMap["steering_delivered"]);
          break;
        case "steering_edited":
          push("steering_edited", event.data as TranscriptEventMap["steering_edited"]);
          break;
        case "steering_removed":
          push("steering_removed", event.data as TranscriptEventMap["steering_removed"]);
          break;
        case "model_done": {
          const data = event.data as {
            stopReason?: AssistantMessage["stopReason"];
            usage?: TokenUsage;
            messageId?: string;
            message: AssistantMessage;
          };
          push("assistant_message", {
            ...(data.messageId !== undefined ? { messageId: data.messageId } : {}),
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
            messageId?: string;
            content: string | ToolResultBlock[];
            displayMetadata?: Record<string, unknown>;
            orderInBatch: number;
          };
          push("tool_result", {
            callId: data.toolCallId,
            name: data.toolName,
            ...(data.messageId !== undefined ? { messageId: data.messageId } : {}),
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
 * Also blanks message ids: tests that use no Id port leave reducer ids empty
 * while the projection synthesizes `proj-N`; compare the ordering contract,
 * not two independent counters.
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

  it("5. a turn cancelled mid-batch leaves an unflushed steering queue", () => {
    const { events, finalState } = driveAndRecord([
      { type: "user_message", content: "go" },
      toolUseDelta("c1", "read_file", '{"path":"a.ts"}'),
      { type: "model_done", stopReason: "tool_use" },
      { type: "user_message", content: "wait" }, // steering: status is executing_tools
      { type: "cancel", reason: "user" },
      { type: "cancel", reason: "user" }, // cancelling → done
    ]);

    // The cancelled batch now pairs its tool_use in history (a synthesized
    // interrupted result — providers reject un-paired tool_use outright),
    // but the queued steering is still NOT delivered: the reducer keeps it
    // in queuedUserInputs (the host auto-run delivers it) and the projection
    // drops it at end-of-log too. end_turn itself no longer leaves an
    // unflushed queue — D3 drains it in-turn (see steering-cross-status.test.ts).
    expect(finalState.queuedUserInputs).toHaveLength(1);
    expect(normalizeIsError(projectMessages(events))).toEqual(normalizeIsError(finalState.messages));
    expect(finalState.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    // The projected wording is byte-identical to the reducer's synthesis.
    const synthesized = (finalState.messages.at(-1)! as { content: ToolResultContent[] }).content[0]!;
    expect(synthesized.content).toEqual([
      {
        type: "text",
        text: 'Tool "read_file" was interrupted: the user cancelled the turn before it finished. The call was not judged either way.',
      },
    ]);
    expect(synthesized.isError).toBe(true);
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

    // A cancel no longer drops a partially-reported batch on the floor:
    // c1's already-arrived result is kept as-is and the missing sibling gets
    // a synthesized interrupted result — roster order, every tool_use paired.
    expect(finalState.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool"]);
    const toolBlocks = finalState.messages
      .filter((m): m is Extract<typeof m, { role: "tool" }> => m.role === "tool")
      .map((m) => m.content[0]!);
    expect(toolBlocks.map((b) => b.toolUseId)).toEqual(["c1", "c2"]);
    expect(toolBlocks[0]!.content).toEqual([{ type: "text", text: "file contents" }]);
    expect(toolBlocks[1]!.content).toEqual([
      {
        type: "text",
        text: 'Tool "list_dir" was interrupted: the user cancelled the turn before it finished. The call was not judged either way.',
      },
    ]);
    expect(toolBlocks[1]!.isError).toBe(true);
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
    // The reducer's Id port is aligned with the projection's proj-N counter
    // here. Production identity now comes from the `messageId` the events
    // carry (see test 12b); this pins the ordering contract under ids that
    // happen to coincide as well.
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

  it("12b. cold rebuild replays compaction from the ids the events carry (production shape)", () => {
    // Production does not align the reducer's Id port with the projection's
    // counter — events carry the reducer's durable messageId instead. This is
    // the shape a rebuild-from-transcript sees: no live state, no aligned ids.
    let n = 0;
    const idPort: Id = { next: () => `m-${++n}` };
    const ctxWithId: StepContext = { tools, model: "test-model", id: idPort };

    const inputs = [
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
        // user=m-1, assistant(tool_use)=m-2, tool=m-3, assistant=m-4.
        // Replace the tool batch, keep the opening user and final reply.
        replacedIds: ["m-2", "m-3"],
      },
    ] as AgentInput[];

    const { events, finalState } = driveAndRecord(inputs, ctxWithId);

    expect(finalState.messages.map((m) => m.id)).toEqual(["m-1", "sum-1", "m-4"]);
    // The projection adopts the events' durable ids, so replacedIds match on
    // a cold rebuild and the pre-compaction messages are really gone.
    expect(projectMessages(events).map((m) => m.id)).toEqual(["m-1", "sum-1", "m-4"]);
    expect(JSON.stringify(projectMessages(events))).not.toContain("file contents");
    expect(normalizeIsError(projectMessages(events))).toEqual(normalizeIsError(finalState.messages));

    // Counter-witness: strip the durable identity (the legacy log shape) and
    // the same events fall back to the "skip the unmatched write-back" branch
    // — exactly the dead branch this test exists to prevent from returning.
    const legacyEvents = events.map((event) => {
      if (
        event.type !== "user_message"
        && event.type !== "assistant_message"
        && event.type !== "tool_result"
      ) {
        return event;
      }
      const { messageId: _dropped, ...data } = event.data as Record<string, unknown>;
      return { ...event, data } as TranscriptEvent;
    });
    expect(projectMessages(legacyEvents).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("13. an edited queued entry reaches history with its edited content", () => {
    const { events, finalState } = driveAndRecord([
      { type: "user_message", content: "go" },
      toolUseDelta("c1", "read_file", '{"path":"a.ts"}'),
      { type: "model_done", stopReason: "tool_use" },
      { type: "user_message", content: "first wording" }, // steering: status is executing_tools
      { type: "steering_edit", id: "", content: "reworded" },
      { type: "tool_result", toolCallId: "c1", toolName: "read_file", result: { modelContent: "file contents" } },
    ]);

    expect(normalizeIsError(projectMessages(events))).toEqual(normalizeIsError(finalState.messages));
    const projected = projectMessages(events);
    expect(projected.at(-1)).toMatchObject({ role: "user", content: "reworded" });
    expect(JSON.stringify(projected)).not.toContain("first wording");
  });

  it("14. a removed queued entry leaves no residue in the projected history", () => {
    const { events, finalState } = driveAndRecord([
      { type: "user_message", content: "go" },
      toolUseDelta("c1", "read_file", '{"path":"a.ts"}'),
      { type: "model_done", stopReason: "tool_use" },
      { type: "user_message", content: "withdraw me" }, // steering: status is executing_tools
      { type: "steering_remove", id: "" },
      { type: "tool_result", toolCallId: "c1", toolName: "read_file", result: { modelContent: "file contents" } },
    ]);

    expect(normalizeIsError(projectMessages(events))).toEqual(normalizeIsError(finalState.messages));
    expect(JSON.stringify(projectMessages(events))).not.toContain("withdraw me");
    expect(finalState.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
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

describe("projectMessages — interrupted tool results (termination pairing)", () => {
  it("pairs every un-fulfilled tool_use at a cancelled turn_end, approval-pending call last", () => {
    const events = log([
      { time: 1, type: "user_message", data: { content: "go" }, turn: 1 },
      {
        time: 2,
        type: "assistant_message",
        data: {
          content: [
            { type: "tool_use", id: "c1", name: "bash", input: {} },
            { type: "tool_use", id: "c2", name: "read_file", input: {} },
          ],
          stopReason: "tool_use",
          durationMs: 5,
        },
        turn: 1,
        step: 1,
      },
      // c1 is pulled out of the batch for approval and the turn dies before
      // any decision: the reducer pairs in roster order — the still-executing
      // sibling first, the approval-pending call last (the decision would
      // have appended it back at the end).
      { time: 3, type: "approval_asked", data: { callId: "c1", name: "bash", riskTier: "WRITE_HIGH" }, turn: 1, step: 1 },
      { time: 4, type: "turn_end", data: { turn: 1, reason: "cancelled" }, turn: 1 },
    ]);

    expect(stripIds(projectMessages(events).slice(2))).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolUseId: "c2",
            content: [
              {
                type: "text",
                text: 'Tool "read_file" was interrupted: the user cancelled the turn before it finished. The call was not judged either way.',
              },
            ],
            isError: true,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolUseId: "c1",
            content: [
              {
                type: "text",
                text: 'Tool "bash" was interrupted: the user cancelled the turn before it finished. The call was not judged either way.',
              },
            ],
            isError: true,
          },
        ],
      },
    ]);
  });

  it("uses the limit wording when the turn ends on a safety limit", () => {
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
      {
        time: 3,
        type: "turn_end",
        data: { turn: 1, reason: "budget_exceeded", error: "Cost budget exceeded" },
        turn: 1,
      },
    ]);

    expect(stripIds(projectMessages(events).slice(2))).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolUseId: "c1",
            content: [
              {
                type: "text",
                text: 'Tool "read_file" was interrupted: the turn was terminated by a safety limit before it finished.',
              },
            ],
            isError: true,
          },
        ],
      },
    ]);
  });

  it("keeps a real result that arrived before the termination and synthesizes only the missing ones", () => {
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
        data: { callId: "c1", name: "read_file", content: "file contents", isError: false, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
      {
        time: 4,
        type: "turn_end",
        data: { turn: 1, reason: "error", error: "Maximum iterations reached" },
        turn: 1,
      },
    ]);

    const toolViews = projectMessages(events).slice(2).map((m) => ({
      toolUseId: (m.content as ToolResultContent[])[0]!.toolUseId,
      text: ((m.content as ToolResultContent[])[0]!.content as Array<{ text: string }>)[0]!.text,
    }));
    expect(toolViews).toEqual([
      { toolUseId: "c1", text: "file contents" },
      {
        toolUseId: "c2",
        text: 'Tool "list_dir" was interrupted: the turn was terminated by a safety limit before it finished.',
      },
    ]);
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

import { buildTurnRecords, toConversationView } from "../view-projection.js";

// ──────────────────────────────────────────────────────────────────────────
// Steering queue realization (Task 6). `steering_delivered{ids}` realizes
// queued entries at the delivery point; `steering_edited` / `steering_removed`
// mutate the queued entry before it is ever realized; legacy `steering_queued`
// events without an `id` keep the pre-feature structural placement.
// ──────────────────────────────────────────────────────────────────────────

/** Turn 1 dies before any drain; turn 2 opens with the D11b idle pre-flush. */
const CROSS_TURN_LOG = log([
  { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
  { time: 110, type: "user_message", data: { content: "go" }, turn: 1 },
  { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
  {
    time: 130,
    type: "assistant_message",
    data: {
      content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }],
      stopReason: "tool_use",
      durationMs: 5,
    },
    turn: 1,
    step: 1,
  },
  { time: 140, type: "tool_call", data: { callId: "c1", name: "read_file", input: {} }, turn: 1, step: 1 },
  { time: 150, type: "steering_queued", data: { id: "steer-1", content: "wait" }, turn: 1, step: 1 },
  { time: 160, type: "turn_end", data: { turn: 1, reason: "cancelled" }, turn: 1 },
  // run() records the opening input BEFORE the drain's steering_delivered, so
  // the durable order is [user_message, steering_delivered] — but the
  // reducer's message order is [...olderQueue, newUserMsg].
  { time: 200, type: "turn_start", data: { turn: 2 }, turn: 2 },
  { time: 210, type: "user_message", data: { content: "again" }, turn: 2 },
  { time: 220, type: "steering_delivered", data: { ids: ["steer-1"] }, turn: 2 },
  { time: 230, type: "model_call_start", data: { headerHash: "h1" }, turn: 2, step: 1 },
  {
    time: 240,
    type: "assistant_message",
    data: { content: [{ type: "text", text: "two" }], stopReason: "end_turn", durationMs: 5 },
    turn: 2,
    step: 1,
  },
  { time: 250, type: "turn_end", data: { turn: 2, reason: "done" }, turn: 2 },
]);

describe("projectMessages — steering queue realization", () => {
  it("edited queued entry renders the edited content at its delivery position", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "user_message", data: { content: "go" }, turn: 1 },
      { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      {
        time: 130,
        type: "assistant_message",
        data: {
          content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }],
          stopReason: "tool_use",
          durationMs: 5,
        },
        turn: 1,
        step: 1,
      },
      { time: 140, type: "steering_queued", data: { id: "steer-1", content: "first wording" }, turn: 1, step: 1 },
      { time: 150, type: "steering_edited", data: { id: "steer-1", content: "reworded" }, turn: 1, step: 1 },
      {
        time: 160,
        type: "tool_result",
        data: { callId: "c1", name: "read_file", content: "text", isError: false, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
      { time: 170, type: "steering_delivered", data: { ids: ["steer-1"] }, turn: 1 },
      { time: 180, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 2 },
      {
        time: 190,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", durationMs: 5 },
        turn: 1,
        step: 2,
      },
      { time: 200, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
    ]);

    // The entry renders exactly once, at the delivery point (after the
    // batch's tool result, before the next model step) — with the EDITED
    // content; the original wording is nowhere in the history.
    expect(stripIds(projectMessages(events))).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }],
        stopReason: "tool_use",
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "text" }], isError: false }],
      },
      { role: "user", content: "reworded" },
      { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ]);
    expect(JSON.stringify(projectMessages(events))).not.toContain("first wording");

    // The view renders the edited content at the same delivery position:
    // between step 1 (whose tool result is folded in) and step 2.
    const view = toConversationView(buildTurnRecords(events));
    expect(view.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "go"],
      ["assistant", ""],
      ["user", "reworded"],
      ["assistant", "ok"],
    ]);
    expect(JSON.stringify(view.messages)).not.toContain("first wording");
  });

  it("removed queued entry leaves no residue in transcript or view", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "user_message", data: { content: "go" }, turn: 1 },
      { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      {
        time: 130,
        type: "assistant_message",
        data: {
          content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }],
          stopReason: "tool_use",
          durationMs: 5,
        },
        turn: 1,
        step: 1,
      },
      { time: 140, type: "steering_queued", data: { id: "steer-1", content: "withdraw me" }, turn: 1, step: 1 },
      { time: 150, type: "steering_removed", data: { id: "steer-1" }, turn: 1, step: 1 },
      {
        time: 160,
        type: "tool_result",
        data: { callId: "c1", name: "read_file", content: "text", isError: false, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
      // The queue is empty at the drain, so no steering_delivered is emitted.
      { time: 180, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 2 },
      {
        time: 190,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", durationMs: 5 },
        turn: 1,
        step: 2,
      },
      { time: 200, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
    ]);

    const messages = projectMessages(events);
    expect(stripIds(messages).map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(JSON.stringify(messages)).not.toContain("withdraw me");

    const records = buildTurnRecords(events);
    expect(records[0]!.userInput).toEqual([{ origin: "direct", content: "go", time: 110 }]);
    const view = toConversationView(records);
    expect(view.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "go"],
      ["assistant", ""],
      ["assistant", "ok"],
    ]);
  });

  it("an entry queued in turn N and delivered in turn N+1 renders exactly once, in the delivering turn", () => {
    const messages = projectMessages(CROSS_TURN_LOG);

    // Anchored at the delivering turn's OPENING — before "again", matching
    // the reducer's [...olderQueue, newUserMsg] byte for byte — and exactly
    // once, in the delivering turn only.
    expect(stripIds(messages)).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }],
        stopReason: "tool_use",
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolUseId: "c1",
            content: [
              {
                type: "text",
                text: 'Tool "read_file" was interrupted: the user cancelled the turn before it finished. The call was not judged either way.',
              },
            ],
            isError: true,
          },
        ],
      },
      { role: "user", content: "wait" },
      { role: "user", content: "again" },
      { role: "assistant", content: [{ type: "text", text: "two" }], stopReason: "end_turn" },
    ]);
    expect(messages.filter((m) => JSON.stringify(m.content).includes('"wait"') || m.content === "wait")).toHaveLength(1);
  });

  it("an unrealized entry stays at its turn end in view and is dropped from transcript", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "user_message", data: { content: "go" }, turn: 1 },
      { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      {
        time: 130,
        type: "assistant_message",
        data: {
          content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }],
          stopReason: "tool_use",
          durationMs: 5,
        },
        turn: 1,
        step: 1,
      },
      { time: 140, type: "tool_call", data: { callId: "c1", name: "read_file", input: {} }, turn: 1, step: 1 },
      { time: 150, type: "steering_queued", data: { id: "steer-1", content: "one more thing" }, turn: 1, step: 1 },
      // The turn dies before any drain — no steering_delivered ever names
      // the entry.
      { time: 160, type: "turn_end", data: { turn: 1, reason: "cancelled" }, turn: 1 },
    ]);

    // Transcript: a queue that never reached a drain point is dropped —
    // never appended at end-of-log or end-of-turn.
    expect(JSON.stringify(projectMessages(events))).not.toContain("one more thing");

    // View: the same entry stays visible at its turn's end.
    const view = toConversationView(buildTurnRecords(events));
    expect(view.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "go"],
      ["assistant", ""],
      ["user", "one more thing"],
    ]);
  });

  it("legacy steering_queued without id falls back to structural placement without throwing", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "user_message", data: { content: "go" }, turn: 1 },
      { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      {
        time: 130,
        type: "assistant_message",
        data: {
          content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }],
          stopReason: "tool_use",
          durationMs: 5,
        },
        turn: 1,
        step: 1,
      },
      // Pre-feature transcript: the queued event carries no id.
      {
        time: 140,
        type: "steering_queued",
        data: { content: "legacy steer" } as unknown as { id: string; content: string },
        turn: 1,
        step: 1,
      },
      {
        time: 150,
        type: "tool_result",
        data: { callId: "c1", name: "read_file", content: "text", isError: false, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
      { time: 180, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 2 },
      {
        time: 190,
        type: "assistant_message",
        data: {
          content: [{ type: "tool_use", id: "c2", name: "list_dir", input: {} }],
          stopReason: "tool_use",
          durationMs: 5,
        },
        turn: 1,
        step: 2,
      },
      // A modern id-carrying entry alongside — realized by its own event.
      { time: 230, type: "steering_queued", data: { id: "steer-1", content: "modern steer" }, turn: 1, step: 2 },
      {
        time: 250,
        type: "tool_result",
        data: { callId: "c2", name: "list_dir", content: "a,b", isError: false, orderInBatch: 0 },
        turn: 1,
        step: 2,
      },
      { time: 260, type: "steering_delivered", data: { ids: ["steer-1"] }, turn: 1 },
      { time: 280, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 3 },
      {
        time: 290,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "done" }], stopReason: "end_turn", durationMs: 5 },
        turn: 1,
        step: 3,
      },
      { time: 300, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
    ]);

    expect(() => projectMessages(events)).not.toThrow();
    // The legacy entry keeps its structural slot (after batch 1's results);
    // the modern one lands at its delivered point (after batch 2's).
    expect(stripIds(projectMessages(events)).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
      "assistant",
      "tool",
      "user",
      "assistant",
    ]);
    expect(projectMessages(events).filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "go",
      "legacy steer",
      "modern steer",
    ]);

    // The view keeps the legacy time heuristic for the id-less entry and the
    // delivered anchor for the modern one — same visible order.
    expect(() => buildTurnRecords(events)).not.toThrow();
    const view = toConversationView(buildTurnRecords(events));
    expect(view.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "go",
      "legacy steer",
      "modern steer",
    ]);
  });

  it("a steering_flush turn realizes the queue at its opening, before any user_message", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "user_message", data: { content: "go" }, turn: 1 },
      { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      { time: 130, type: "steering_queued", data: { id: "steer-1", content: "wait" }, turn: 1, step: 1 },
      { time: 140, type: "model_error", data: { error: "boom", retriable: false }, turn: 1, step: 1 },
      { time: 150, type: "turn_end", data: { turn: 1, reason: "error", error: "boom" }, turn: 1 },
      // steering_flush opens turn 2: the whole queue is realized with NO
      // user_message event at all.
      { time: 200, type: "turn_start", data: { turn: 2 }, turn: 2 },
      { time: 210, type: "steering_delivered", data: { ids: ["steer-1"] }, turn: 2 },
      { time: 230, type: "model_call_start", data: { headerHash: "h1" }, turn: 2, step: 1 },
      {
        time: 240,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "two" }], stopReason: "end_turn", durationMs: 5 },
        turn: 2,
        step: 1,
      },
      { time: 250, type: "turn_end", data: { turn: 2, reason: "done" }, turn: 2 },
    ]);

    expect(projectMessages(events).map((m) => [m.role, m.content])).toEqual([
      ["user", "go"],
      ["user", "wait"],
      ["assistant", [{ type: "text", text: "two" }]],
    ]);

    // View: the entry moved into the delivering turn as a DIRECT input — the
    // turn's opening — exactly once.
    const [turn1, turn2] = buildTurnRecords(events);
    expect(turn1!.userInput).toEqual([{ origin: "direct", content: "go", time: 110 }]);
    expect(turn2!.userInput).toEqual([{ origin: "direct", content: "wait", time: 130 }]);
    const view = toConversationView(buildTurnRecords(events));
    expect(view.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "go"],
      // Turn 1's errored step still renders its (empty) assistant row.
      ["assistant", ""],
      ["user", "wait"],
      ["assistant", "two"],
    ]);
  });
});

describe("projectMessages — steering queue realization (FIFO)", () => {
  it("realizes a multi-entry cross-turn drain in FIFO order at the turn opening", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "user_message", data: { content: "go" }, turn: 1 },
      { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      { time: 130, type: "steering_queued", data: { id: "steer-1", content: "first steer" }, turn: 1, step: 1 },
      { time: 140, type: "steering_queued", data: { id: "steer-2", content: "second steer" }, turn: 1, step: 1 },
      { time: 150, type: "model_error", data: { error: "boom", retriable: false }, turn: 1, step: 1 },
      { time: 160, type: "turn_end", data: { turn: 1, reason: "error", error: "boom" }, turn: 1 },
      { time: 200, type: "turn_start", data: { turn: 2 }, turn: 2 },
      { time: 210, type: "user_message", data: { content: "again" }, turn: 2 },
      { time: 220, type: "steering_delivered", data: { ids: ["steer-1", "steer-2"] }, turn: 2 },
      { time: 230, type: "model_call_start", data: { headerHash: "h1" }, turn: 2, step: 1 },
      {
        time: 240,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "two" }], stopReason: "end_turn", durationMs: 5 },
        turn: 2,
        step: 1,
      },
      { time: 250, type: "turn_end", data: { turn: 2, reason: "done" }, turn: 2 },
    ]);

    // Both anchors runs keep the drain's FIFO order, still ahead of "again".
    expect(projectMessages(events).map((m) => m.content)).toEqual([
      "go",
      "first steer",
      "second steer",
      "again",
      [{ type: "text", text: "two" }],
    ]);
    const [, turn2] = buildTurnRecords(events);
    expect(turn2!.userInput.map((u) => u.content)).toEqual(["first steer", "second steer", "again"]);
    const view = toConversationView(buildTurnRecords(events));
    expect(view.messages.map((m) => [m.id, m.content])).toEqual([
      ["1:u0", "go"],
      // Turn 1's errored step still renders its (empty) assistant row.
      ["1:1", ""],
      ["2:u0", "first steer"],
      ["2:u1", "second steer"],
      ["2:u2", "again"],
      ["2:1", "two"],
    ]);
  });
});
