import { describe, it, expect } from "vitest";
import {
  ReasoningEffortId,
  createMockModelPort,
  modelDoneWithMeta,
  type ModelPort,
  type ResolvedModelInfo,
  extractBlockText,
  type AssistantMessage,
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
    const port = createMockModelPort([[modelDoneWithMeta("end_turn", { blocks: ["sig-1"] })]]);
    const events = [];
    for await (const event of port.stream({
      messages: [],
      tools: [],
      reasoningEffort: ReasoningEffortId("max"),
    })) {
      events.push(event);
    }
    expect(events[0]).toEqual({ type: "done", stopReason: "end_turn", meta: { blocks: ["sig-1"] } });
  });
});

describe("reasoning content block", () => {
  it("is part of an assistant message and extracts to no user-visible text", () => {
    const msg: AssistantMessage = {
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
