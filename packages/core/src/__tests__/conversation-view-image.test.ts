import { describe, it, expect } from "vitest";
import { buildTurnRecords, toConversationView } from "../view-projection.js";
import { step, createInitialState } from "../index.js";
import type {
  ConversationBlock,
  Effect,
  ReducerState,
  StepContext,
  TranscriptEvent,
} from "../index.js";

function log(entries: Array<Omit<TranscriptEvent, "seq">>): TranscriptEvent[] {
  return entries.map((e, i) => ({ ...e, seq: i }) as TranscriptEvent);
}

const imageBlock = {
  type: "image" as const,
  source: { type: "ref" as const, id: "att-42", mediaType: "image/png" },
  width: 800,
  height: 600,
};

const ctx: StepContext = { tools: [], model: "test-model" };

function emitted(effects: Effect[], type: string): Record<string, unknown> | undefined {
  for (const e of effects) {
    if (e.type === "emit" && e.event.type === type) return e.event.data;
  }
  return undefined;
}

describe("toConversationView — user image blocks", () => {
  it("emits a ref-only image block for a user message that carries one", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      {
        time: 110,
        type: "user_message",
        data: { content: [{ type: "text", text: "what is this" }, imageBlock] },
        turn: 1,
      },
      { time: 120, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
    ]);

    const message = toConversationView(buildTurnRecords(events)).messages[0]!;
    expect(message.role).toBe("user");
    expect(message.blocks).toContainEqual({
      type: "image",
      attachmentId: "att-42",
      mediaType: "image/png",
      width: 800,
      height: 600,
    });
    // Clipboard string stays text-only.
    expect(message.content).toBe("what is this");
    // Ref-only: base64 must never enter this projection.
    expect(JSON.stringify(message.blocks)).not.toMatch(/iVBOR|data:image/);
  });

  it("emits an image block even when the message has no text", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "user_message", data: { content: [imageBlock] }, turn: 1 },
      { time: 120, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
    ]);

    const message = toConversationView(buildTurnRecords(events)).messages[0]!;
    expect(message.content).toBe("");
    expect(message.blocks).toEqual([
      {
        type: "image",
        attachmentId: "att-42",
        mediaType: "image/png",
        width: 800,
        height: 600,
      },
    ]);
  });

  it("keeps existing text-only user messages unchanged", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "user_message", data: { content: "hello" }, turn: 1 },
      { time: 120, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
    ]);

    const message = toConversationView(buildTurnRecords(events)).messages[0]!;
    expect(message.blocks).toEqual([{ type: "text", text: "hello" }]);
  });
});

describe("reducer tool_result emit — image blocks survive", () => {
  function runToToolResult(modelContent: string | Array<{ type: "text"; text: string } | typeof imageBlock>) {
    let state: ReducerState = createInitialState();
    state = step(state, { type: "user_message", content: "go" }, ctx).state;
    state = step(
      state,
      {
        type: "model_chunk",
        chunk: {
          type: "tool_use_delta",
          toolCallId: "c1",
          toolCallName: "read_file",
          argumentsDelta: "{}",
        },
      },
      ctx,
    ).state;
    state = step(state, { type: "model_done", stopReason: "tool_use" }, ctx).state;
    return step(
      state,
      {
        type: "tool_result",
        toolCallId: "c1",
        toolName: "read_file",
        result: { modelContent },
      },
      ctx,
    );
  }

  it("passes structured blocks through instead of joining text", () => {
    const blocks = [{ type: "text" as const, text: "caption" }, imageBlock];
    const result = runToToolResult(blocks);
    const data = emitted(result.effects, "tool_result");
    expect(data).toBeDefined();
    expect(data!["content"]).toEqual(blocks);
  });

  it("still passes a plain string result through unchanged", () => {
    const result = runToToolResult("plain text");
    expect(emitted(result.effects, "tool_result")!["content"]).toBe("plain text");
  });

  it("keeps the image ref in the flushed tool message as well", () => {
    const blocks = [imageBlock];
    const result = runToToolResult(blocks);
    // The batch is complete after a single result, so the flushed assistant
    // message plus the tool message both land in state.messages.
    const toolMsg = result.state.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const inner = (toolMsg!.content as Array<{ type: string; content: unknown }>)[0]!;
    expect(inner.type).toBe("tool_result");
    expect(inner.content).toEqual(blocks);
  });
});

describe("buildTurnRecords — tool_result content stays structured", () => {
  it("stores the block array on the call record (text views extract later)", () => {
    const blocks = [{ type: "text" as const, text: "caption" }, imageBlock];
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "user_message", data: { content: "go" }, turn: 1 },
      { time: 120, type: "model_call_start", data: { headerHash: "h" }, turn: 1, step: 1 },
      {
        time: 130,
        type: "assistant_message",
        data: {
          content: [
            {
              type: "tool_use",
              id: "c1",
              name: "read_file",
              input: { path: "a.png" },
            },
          ],
          stopReason: "tool_use",
          durationMs: 5,
        },
        turn: 1,
        step: 1,
      },
      {
        time: 140,
        type: "tool_call",
        data: { callId: "c1", name: "read_file", input: { path: "a.png" } },
        turn: 1,
        step: 1,
      },
      {
        time: 150,
        type: "tool_result",
        data: { callId: "c1", name: "read_file", content: blocks, isError: false, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
      { time: 160, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
    ]);

    const records = buildTurnRecords(events);
    const call = records[0]!.steps[0]!.toolCalls[0]!;
    expect(call.content).toEqual(blocks);

    // The text-only conversation view still renders via extractBlockText.
    const view = toConversationView(records);
    const toolBlock = view.messages[1]!.blocks.find(
      (b): b is Extract<ConversationBlock, { type: "tool_call" }> => b.type === "tool_call",
    )!;
    expect(toolBlock.call.result).toContain("caption");
    expect(toolBlock.call.result).toContain("[image:");
  });
});

describe("user_message emit path already preserves image blocks", () => {
  it("reducer emits the original content array, not a flattened string", () => {
    let state: ReducerState = createInitialState();
    const content = [{ type: "text" as const, text: "look" }, imageBlock];
    const result = step(state, { type: "user_message", content }, ctx);
    const data = emitted(result.effects, "user_message");
    expect(data).toBeDefined();
    expect(data!["content"]).toEqual(content);
    state = result.state;
  });
});
