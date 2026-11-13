/**
 * Structured tool_result transcript round-trip (T6 Task 3, F-203 ← F-021) —
 * a `structured` block inside a tool_result must survive recording,
 * JSON serialization (what the file/jsonl stores do on disk), and read-back
 * with kind/data/text intact, and the UI projection must degrade it to its
 * REQUIRED text projection instead of crashing.
 */

import { describe, it, expect } from "vitest";
import { createTranscriptRecorder } from "../transcript-recorder.js";
import { projectMessages, buildTurnRecords, toConversationView } from "@voltojs/core";
import type {
  Message,
  ToolResultBlock,
  ToolResultContent,
  TranscriptEvent,
  TranscriptEventInput,
  TranscriptStore,
} from "@voltojs/core";

const STRUCT_BLOCK: ToolResultBlock = {
  type: "structured",
  kind: "test.roundtrip",
  data: { a: 1, nested: { b: ["x", 2] } },
  text: "projection",
};

/**
 * A store that serializes each batch through JSON before keeping it, the way
 * the file/jsonl transcript stores do on disk — the read-back therefore sees
 * the JSON round-trip, not the recorder's original object graph.
 */
function jsonStore(sink: TranscriptEventInput[]): TranscriptStore {
  return {
    appendEvents: async (_sessionId: string, events: TranscriptEventInput[]) => {
      sink.push(...(JSON.parse(JSON.stringify(events)) as TranscriptEventInput[]));
    },
  };
}

/** Assign seq the way a real store would, so projectMessages accepts the log. */
function asStored(sink: TranscriptEventInput[]): TranscriptEvent[] {
  return sink.map((e, i) => ({ ...e, seq: i }) as TranscriptEvent);
}

const ASSISTANT_TOOL_USE: TranscriptEvent = {
  seq: 0,
  time: 900,
  type: "assistant_message",
  turn: 1,
  step: 1,
  data: {
    content: [{ type: "tool_use", id: "c1", name: "test_tool", input: {} }],
    stopReason: "tool_use",
    durationMs: 1,
  },
};

/** Record one tool_call + its tool_result carrying the structured block, then read back. */
async function recordAndReadBack(): Promise<TranscriptEvent[]> {
  const sink: TranscriptEventInput[] = [];
  const recorder = createTranscriptRecorder({
    store: jsonStore(sink),
    sessionId: "session-1",
    turn: 1,
    now: () => 1000,
  });
  // The runner records tool_call (tool_use_complete) before tool_result; the
  // conversation view links a result to its assistant block through that call.
  recorder.record("tool_call", { callId: "c1", name: "test_tool", input: {} }, { step: 1 });
  recorder.record("tool_result", {
    callId: "c1",
    name: "test_tool",
    content: [STRUCT_BLOCK],
    isError: false,
    orderInBatch: 0,
  });
  await recorder.flush();
  // Prepend the assistant_message that opened the batch — the projection
  // pairs a tool_result into its batch and drops an unmatched one.
  return [
    ASSISTANT_TOOL_USE,
    ...asStored(sink).map((e) => ({ ...e, seq: e.seq + 1 })),
  ];
}

function toolResultBlockOf(message: Message): ToolResultContent {
  if (typeof message.content === "string") throw new Error("expected block content");
  const block = message.content[0];
  if (block?.type !== "tool_result") throw new Error("expected tool_result block");
  return block;
}

describe("structured tool_result transcript round-trip (F-203)", () => {
  it("record + read-back keeps kind/data/text through the JSON serialization step", async () => {
    const stored = await recordAndReadBack();
    const event = stored.find((e) => e.type === "tool_result")!;
    const content = (event.data as { content: ToolResultBlock[] }).content;
    expect(content).toEqual([STRUCT_BLOCK]);
  });

  it("projectMessages rebuilds the tool message with kind/data/text intact", async () => {
    const stored = await recordAndReadBack();
    const messages = projectMessages(stored);
    // assistant(tool_use) + the paired tool_result.
    expect(messages).toHaveLength(2);
    const toolMsg = messages.find((m) => m.role === "tool")!;
    const block = toolResultBlockOf(toolMsg).content[0];
    expect(block).toEqual(STRUCT_BLOCK);
    if (block?.type !== "structured") throw new Error("expected structured block");
    expect(block.kind).toBe("test.roundtrip");
    expect(block.data).toEqual({ a: 1, nested: { b: ["x", 2] } });
    expect(block.text).toBe("projection");
  });

  it("conversation view degrades the structured block to its text projection", async () => {
    const stored = await recordAndReadBack();
    const view = toConversationView(buildTurnRecords(stored));
    const assistant = view.messages.find((m) => m.role === "assistant")!;
    const call = assistant.blocks.find((b) => b.type === "tool_call");
    expect(call).toBeDefined();
    if (call?.type !== "tool_call") throw new Error("expected tool_call block");
    // The structured block has no dedicated chat shape; its REQUIRED text
    // projection is the single degradation exit (view-projection toolResultText).
    expect(call.call.result).toBe("projection");
  });
});
