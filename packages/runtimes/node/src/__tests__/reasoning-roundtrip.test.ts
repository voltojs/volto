import { describe, it, expect } from "vitest";
import {
  createMockModelPort,
  modelDone,
  modelDoneWithMeta,
  reasoningDelta,
  textDelta,
  ReasoningEffortId,
  type ModelRequest,
  type StepContext,
} from "@volto/core";
import { createRunner } from "../runner.js";

describe("runner threads reasoning effort and replay state", () => {
  it("sends the effort and stores the envelope on the assistant message", async () => {
    const seen: ModelRequest[] = [];
    const mock = createMockModelPort([
      [reasoningDelta("weighing options"), textDelta("done"), modelDoneWithMeta("end_turn", { blocks: ["sig-1"] })],
    ]);
    const modelPort = {
      async *stream(req: ModelRequest) {
        seen.push(req);
        yield* mock.stream(req);
      },
    };

    const stepContext: StepContext = {
      tools: [],
      model: "thinker",
      reasoningEffort: ReasoningEffortId("high"),
    };

    const runner = createRunner({ modelPort, stepContext });
    const finalState = await runner.run({ type: "user_message", content: "hi" });

    expect(seen[0]?.reasoningEffort).toBe("high");

    const assistant = finalState.messages.filter((m) => m.role === "assistant").at(-1)!;
    expect(assistant.content[0]).toEqual({ type: "reasoning", text: "weighing options" });
    expect(assistant.modelMeta).toEqual({ blocks: ["sig-1"] });
    expect(assistant.source).toEqual({ modelId: "thinker" });
  });

  it("leaves reasoningEffort undefined on the request when none is configured", async () => {
    const seen: ModelRequest[] = [];
    const mock = createMockModelPort([[textDelta("done"), modelDone("end_turn")]]);
    const modelPort = {
      async *stream(req: ModelRequest) {
        seen.push(req);
        yield* mock.stream(req);
      },
    };

    const stepContext: StepContext = {
      tools: [],
      model: "thinker",
    };

    const runner = createRunner({ modelPort, stepContext });
    await runner.run({ type: "user_message", content: "hi" });

    expect(seen[0]?.reasoningEffort).toBeUndefined();
  });
});
