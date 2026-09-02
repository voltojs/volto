import { describe, it, expect } from "vitest";
import { createEventMapper, formatSSEFrame } from "../event-mapper.js";
import { SSEEventType } from "../types.js";
import type { TokenData, ToolCallData, ToolResultData, ErrorData } from "../types.js";

describe("createEventMapper", () => {
  it("accumulates text across token events", () => {
    const mapper = createEventMapper();

    const first = mapper.map({ type: "text_delta", data: { text: "Hello" } });
    const second = mapper.map({ type: "text_delta", data: { text: " world" } });

    expect(first?.event).toBe(SSEEventType.TOKEN);
    expect(first?.data).toEqual<TokenData>({ content: "Hello", delta: "Hello" });
    expect(second?.data).toEqual<TokenData>({
      content: "Hello world",
      delta: " world",
    });
  });

  it("assigns monotonic ids usable for Last-Event-ID recovery", () => {
    const mapper = createEventMapper();

    const ids = [
      mapper.map({ type: "text_delta", data: { text: "a" } })!.id,
      mapper.map({ type: "text_delta", data: { text: "b" } })!.id,
      mapper.done().id,
    ];

    expect(ids).toEqual(["1", "2", "3"]);
  });

  it("maps tool_use_complete to a tool_call message", () => {
    const mapper = createEventMapper();

    const message = mapper.map({
      type: "tool_use_complete",
      data: { toolCallId: "call-1", toolName: "read_file", input: { path: "a.ts" } },
    });

    expect(message?.event).toBe(SSEEventType.TOOL_CALL);
    expect(message?.data).toEqual<ToolCallData>({
      id: "call-1",
      name: "read_file",
      args: { path: "a.ts" },
    });
  });

  it("maps tool_result and preserves the error flag", () => {
    const mapper = createEventMapper();

    const message = mapper.map({
      type: "tool_result",
      data: { toolCallId: "call-1", toolName: "read_file", isError: true, durationMs: 12 },
    });

    expect(message?.event).toBe(SSEEventType.TOOL_RESULT);
    const data = message?.data as ToolResultData;
    expect(data.id).toBe("call-1");
    expect(data.isError).toBe(true);
  });

  it("maps agent errors onto the error event", () => {
    const mapper = createEventMapper();

    const message = mapper.map({
      type: "error",
      data: { error: "model exploded", retriable: true },
    });

    expect(message?.event).toBe(SSEEventType.ERROR);
    expect(message?.data).toEqual<ErrorData>({
      code: "AGENT_ERROR",
      message: "model exploded",
      retryable: true,
    });
  });

  it("drops events that carry no meaning for a chat client", () => {
    const mapper = createEventMapper();

    expect(mapper.map({ type: "tool_use_delta", data: { partial: "{" } })).toBeNull();
    expect(mapper.map({ type: "user_message", data: { content: "hi" } })).toBeNull();
    expect(mapper.map({ type: "text_delta", data: { text: "" } })).toBeNull();
  });

  it("surfaces unknown events as state changes rather than dropping them", () => {
    const mapper = createEventMapper();

    const message = mapper.map({ type: "model_done", data: { stopReason: "end_turn" } });

    expect(message?.event).toBe(SSEEventType.STATE_CHANGE);
    expect((message?.data as { state: string }).state).toBe("model_done");
  });

  it("carries the full turn text on done, and resets for the next turn", () => {
    const mapper = createEventMapper();

    mapper.map({ type: "text_delta", data: { text: "turn one" } });
    expect(mapper.done().data).toEqual({ content: "turn one" });

    mapper.resetTurn();
    mapper.map({ type: "text_delta", data: { text: "turn two" } });
    expect(mapper.getAccumulatedText()).toBe("turn two");
  });
});

describe("formatSSEFrame", () => {
  it("emits id, event and data lines terminated by a blank line", () => {
    const mapper = createEventMapper();
    const message = mapper.map({ type: "text_delta", data: { text: "hi" } })!;

    expect(formatSSEFrame(message)).toBe(
      'id: 1\nevent: token\ndata: {"content":"hi","delta":"hi"}\n\n',
    );
  });
});
