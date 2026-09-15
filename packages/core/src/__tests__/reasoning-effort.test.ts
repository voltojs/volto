import { describe, it, expect } from "vitest";
import {
  ReasoningEffortId,
  type ModelPort,
  type ResolvedModelInfo,
  extractBlockText,
  type AssistantMessage,
  step,
  createInitialState,
  type StepContext,
  projectMessages,
  buildTurnRecords,
  toConversationView,
  type TranscriptEvent,
} from "../index.js";

describe("reasoning effort contract", () => {
  it("brands a plain string into an opaque effort id", () => {
    const id = ReasoningEffortId("high");
    expect(id).toBe("high");
  });

  it("lets a port declare per-model reasoning capability", async () => {
    const port: ModelPort = {
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error("not used in this test");
      },
      describeModel(model: string): Promise<ResolvedModelInfo> {
        return Promise.resolve(
          model === "thinker"
            ? {
                model,
                reasoning: {
                  efforts: [
                    { id: ReasoningEffortId("off"), name: "Off" },
                    { id: ReasoningEffortId("high"), name: "High" },
                  ],
                  defaultEffort: ReasoningEffortId("high"),
                },
              }
            : { model },
        );
      },
    };

    const thinker = await port.describeModel!("thinker");
    expect(thinker.reasoning?.efforts.map((e) => e.id)).toEqual(["off", "high"]);
    expect(thinker.reasoning?.defaultEffort).toBe("high");

    // A model without the capability declares nothing at all — never an
    // off-only list, which would be a control that cannot do what it says.
    const plain = await port.describeModel!("plain");
    expect(plain.reasoning).toBeUndefined();
  });

  it("carries the effort on the request and the envelope on the done event", async () => {
    // A port that records the request it received, so this test can assert
    // reasoningEffort actually reached the port — createMockModelPort's
    // stream() never inspects req, so a script-only assertion here would
    // stay green even if reasoningEffort were dropped before the call.
    let receivedReq: { reasoningEffort?: string } | undefined;
    const port: ModelPort = {
      // eslint-disable-next-line require-yield
      async *stream(req) {
        receivedReq = req;
        yield { type: "done", stopReason: "end_turn", meta: { blocks: ["sig-1"] } };
      },
    };
    const events = [];
    for await (const event of port.stream({
      messages: [],
      tools: [],
      reasoningEffort: ReasoningEffortId("max"),
    })) {
      events.push(event);
    }
    expect(receivedReq?.reasoningEffort).toBe("max");
    expect(events[0]).toEqual({ type: "done", stopReason: "end_turn", meta: { blocks: ["sig-1"] } });
  });
});

describe("reasoning content block", () => {
  it("is part of an assistant message and extracts to no user-visible text", () => {
    const msg: AssistantMessage = {
      id: "m1",
      role: "assistant",
      content: [
        { type: "reasoning", text: "let me think" },
        { type: "text", text: "answer" },
      ],
      source: { modelId: "thinker" },
      modelMeta: { blocks: ["sig-1"] },
    };

    expect(extractBlockText(msg.content[0]!)).toBe("");
    expect(extractBlockText(msg.content[1]!)).toBe("answer");
    expect(msg.modelMeta).toEqual({ blocks: ["sig-1"] });
    expect(msg.source?.modelId).toBe("thinker");
  });
});

describe("reducer assembles reasoning into the assistant message", () => {
  const ctx: StepContext = { tools: [], model: "thinker" };

  it("accumulates reasoning deltas and leads the content with them", () => {
    let state = createInitialState({ status: "calling_model" });

    state = step(state, { type: "model_chunk", chunk: { type: "reasoning_delta", text: "step " } }, ctx).state;
    state = step(state, { type: "model_chunk", chunk: { type: "reasoning_delta", text: "one" } }, ctx).state;
    state = step(state, { type: "model_chunk", chunk: { type: "text_delta", text: "done" } }, ctx).state;

    const result = step(
      state,
      { type: "model_done", stopReason: "end_turn", meta: { blocks: ["sig-1"] } },
      ctx,
    );

    const msg = result.state.messages[result.state.messages.length - 1]! as AssistantMessage;
    expect(msg.role).toBe("assistant");
    expect(msg.content).toEqual([
      { type: "reasoning", text: "step one" },
      { type: "text", text: "done" },
    ]);
    expect(msg.modelMeta).toEqual({ blocks: ["sig-1"] });
    expect(msg.source).toEqual({ modelId: "thinker" });
  });

  it("omits the reasoning block and the envelope when the model produced neither", () => {
    let state = createInitialState({ status: "calling_model" });
    state = step(state, { type: "model_chunk", chunk: { type: "text_delta", text: "hi" } }, ctx).state;

    const msg = step(state, { type: "model_done", stopReason: "end_turn" }, ctx).state.messages[0]!;
    expect(msg.content).toEqual([{ type: "text", text: "hi" }]);
    expect("modelMeta" in msg).toBe(false);
  });

  it("is deterministic: the same input sequence twice yields the same state and effects", () => {
    const inputs = [
      { type: "model_chunk", chunk: { type: "reasoning_delta", text: "think" } },
      { type: "model_chunk", chunk: { type: "text_delta", text: "say" } },
      { type: "model_done", stopReason: "end_turn", meta: { blocks: ["sig-1"] } },
    ] as const;

    const replay = () => {
      let state = createInitialState({ status: "calling_model" });
      const effects = [];
      for (const input of inputs) {
        const result = step(state, input, ctx);
        state = result.state;
        effects.push(...result.effects);
      }
      return { state, effects };
    };

    expect(replay()).toEqual(replay());
  });

  it("does not leak a previous call's reasoning into the next one", () => {
    let state = createInitialState({ status: "calling_model" });
    state = step(state, { type: "model_chunk", chunk: { type: "reasoning_delta", text: "first" } }, ctx).state;
    state = step(state, { type: "model_done", stopReason: "end_turn" }, ctx).state;

    state = { ...state, status: "calling_model" };
    state = step(state, { type: "model_chunk", chunk: { type: "text_delta", text: "second" } }, ctx).state;
    const msg = step(state, { type: "model_done", stopReason: "end_turn" }, ctx).state.messages[1]!;

    expect(msg.content).toEqual([{ type: "text", text: "second" }]);
  });
});

describe("projections read reasoning from the assistant content", () => {
  const events = [
    { seq: 0, type: "turn_start", data: { turn: 1 }, time: 1, turn: 1 },
    {
      seq: 1,
      type: "assistant_message",
      data: {
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "hello" },
        ],
        stopReason: "end_turn",
        durationMs: 5,
        source: { modelId: "thinker" },
        modelMeta: { blocks: ["sig-1"] },
      },
      time: 2,
      turn: 1,
      step: 1,
    },
  ] as unknown as TranscriptEvent[];

  it("rebuilds the assistant message with its replay state intact", () => {
    const messages = projectMessages(events);
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant).toMatchObject({
      role: "assistant",
      modelMeta: { blocks: ["sig-1"] },
      source: { modelId: "thinker" },
    });
  });

  it("emits the reasoning block ahead of the text", () => {
    const view = toConversationView(buildTurnRecords(events));
    const blocks = view.messages.flatMap((m) => m.blocks);
    expect(blocks[0]).toEqual({ type: "reasoning", text: "thinking" });
    expect(blocks[1]).toEqual({ type: "text", text: "hello" });
  });
});
