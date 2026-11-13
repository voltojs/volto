import { describe, it, expect } from "vitest";
import {
  createMockModelPort,
  modelDone,
  modelDoneWithMeta,
  reasoningDelta,
  textDelta,
  toolUseStart,
  toolUseDelta,
  ReasoningEffortId,
  type ModelRequest,
  type StepContext,
  type ToolDefinition,
} from "@voltojs/core";
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

const readTool: ToolDefinition = {
  name: "read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  requires: ["filesystem:read"],
  riskTier: "READ_ONLY",
};

describe("the envelope survives a tool loop", () => {
  it("is present on the assistant message the second request replays", async () => {
    const requests: ModelRequest[] = [];
    const mock = createMockModelPort([
      [
        reasoningDelta("I should look it up"),
        toolUseStart("call_1", "read_file"),
        toolUseDelta("call_1", '{"path":"foo.ts"}'),
        modelDoneWithMeta("tool_use", { blocks: ["sig-1"] }),
      ],
      [textDelta("const x = 1;"), modelDoneWithMeta("end_turn", { blocks: ["sig-2"] })],
    ]);
    const modelPort = {
      async *stream(req: ModelRequest) {
        requests.push(req);
        yield* mock.stream(req);
      },
    };

    const runner = createRunner({
      modelPort,
      stepContext: { tools: [readTool], model: "thinker" },
      toolExecutor: async () => ({ modelContent: "const x = 1;", isError: false }),
      availableCapabilities: new Set(["filesystem:read"]),
    });
    await runner.run({ type: "user_message", content: "Read foo.ts" });

    // The second request must replay the first call's assistant message with
    // both its reasoning block and its adapter-private envelope, or a provider
    // that requires its thinking blocks back would reject it.
    const replayed = requests[1]!.messages.filter((m) => m.role === "assistant").at(-1)!;
    expect(replayed.content[0]).toEqual({ type: "reasoning", text: "I should look it up" });
    expect(replayed.modelMeta).toEqual({ blocks: ["sig-1"] });
  });
});
