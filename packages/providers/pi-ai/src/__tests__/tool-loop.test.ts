import { describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type AssistantMessage as PiAssistantMessage,
  type AssistantMessageEventStream,
  type Context as PiContext,
  type Model,
  type Provider,
  type ThinkingContent as PiThinkingContent,
  type ToolCall as PiToolCall,
} from "@earendil-works/pi-ai";
import type { AssistantMessage, ModelEvent, ModelRequest } from "@volto/core";
import { buildModels } from "../collection.js";
import { createPiAiModelPortFromModels } from "../model-port.js";

/**
 * This test pins the seam between phase one (core carries the opaque
 * `modelMeta` blob across a tool loop) and phase two (this package turns
 * that blob back into pi-ai's real replay signatures). If this behavior
 * regresses, every thinking-capable model breaks on its second turn in a
 * tool loop, and no other test in this suite would notice.
 */

const REASONING_MODEL: Model<"openai-completions"> = {
  id: "reasoner-1",
  name: "Reasoner One",
  api: "openai-completions",
  provider: "acme",
  baseUrl: "https://acme.example/v1",
  reasoning: true,
  thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high" },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

const SIGNATURE = "sig-turn1-abc123";
const THINKING_TEXT = "let me think about the weather";
const TOOL_CALL_ID = "call_1";
const TOOL_CALL_NAME = "get_weather";
const TOOL_CALL_ARGS = { city: "NYC" };

function zeroUsage(): PiAssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Turn 1: a signed thinking block + a tool call, stopping for tool use. */
function turn1Stream(): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const signedThinking: PiThinkingContent = {
    type: "thinking",
    thinking: THINKING_TEXT,
    thinkingSignature: SIGNATURE,
  };
  const toolCall: PiToolCall = {
    type: "toolCall",
    id: TOOL_CALL_ID,
    name: TOOL_CALL_NAME,
    arguments: TOOL_CALL_ARGS,
  };
  const finalMessage: PiAssistantMessage = {
    role: "assistant",
    content: [signedThinking, toolCall],
    api: "openai-completions",
    provider: "acme",
    model: "reasoner-1",
    usage: zeroUsage(),
    stopReason: "toolUse",
    timestamp: 0,
  };
  stream.push({ type: "start", partial: finalMessage });
  stream.push({ type: "done", reason: "toolUse", message: finalMessage });
  stream.end(finalMessage);
  return stream;
}

/** Turn 2: a plain text reply, nothing thinking-related. */
function turn2Stream(): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const finalMessage = fauxAssistantMessage("it's sunny", { stopReason: "stop" });
  stream.push({ type: "start", partial: finalMessage });
  stream.push({ type: "done", reason: "stop", message: finalMessage });
  stream.end(finalMessage);
  return stream;
}

function registerFakeProvider(
  streamSimple: Provider["streamSimple"],
): ReturnType<typeof buildModels> {
  const models = buildModels([]);
  models.setProvider({
    id: "acme",
    name: "acme",
    auth: { apiKey: { name: "test", resolve: async () => ({ auth: {} }) } },
    getModels: () => [REASONING_MODEL],
    streamSimple,
    stream: () => {
      throw new Error("not used in this test");
    },
  });
  return models;
}

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

/**
 * Build the second request's message history the way volto's Runner would:
 * the user turn, the assistant turn that produced the thinking+tool_use
 * blocks (carrying whatever `modelMeta` the first turn's `done` event
 * produced, plus the `source` the kernel stamps), and the tool result.
 */
function buildSecondTurnMessages(modelMeta: unknown, sourceModelId: string): ModelRequest["messages"] {
  const assistantMessage: AssistantMessage = {
    id: "m2",
    role: "assistant",
    content: [
      { type: "reasoning", text: THINKING_TEXT },
      { type: "tool_use", id: TOOL_CALL_ID, name: TOOL_CALL_NAME, input: TOOL_CALL_ARGS },
    ],
    stopReason: "tool_use",
    source: { modelId: sourceModelId },
    modelMeta,
  };
  return [
    { id: "m3", role: "user", content: "what's the weather in NYC?" },
    assistantMessage,
    {
      id: "m4",
      role: "tool",
      content: [{ toolUseId: TOOL_CALL_ID, type: "tool_result", content: "sunny, 72F" }],
    },
  ];
}

describe("tool loop: thinking signature round-trip", () => {
  it("carries the first turn's signature onto the second call's Context", async () => {
    const streamSimple = vi.fn<Provider["streamSimple"]>();
    streamSimple.mockImplementationOnce(() => turn1Stream());
    streamSimple.mockImplementationOnce(() => turn2Stream());
    const models = registerFakeProvider(streamSimple);
    const port = createPiAiModelPortFromModels(models, "acme");

    // Turn 1: run the request, collect the done event's replay envelope.
    const turn1Events = await collect(
      port.stream({
        model: "reasoner-1",
        messages: [{ id: "m5", role: "user", content: "what's the weather in NYC?" }],
        tools: [],
      }),
    );
    const doneEvent = turn1Events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    const modelMeta = (doneEvent as Extract<ModelEvent, { type: "done" }>).meta;

    // Turn 2: assemble the next request's messages the way the Runner would,
    // carrying the assistant message's reasoning block + modelMeta forward.
    const req2: ModelRequest = {
      model: "reasoner-1",
      messages: buildSecondTurnMessages(modelMeta, "reasoner-1"),
      tools: [],
    };
    await collect(port.stream(req2));

    expect(streamSimple).toHaveBeenCalledTimes(2);
    const [, secondContext] = streamSimple.mock.calls[1]!;
    const context = secondContext as PiContext;
    const assistantMsg = context.messages.find((m) => m.role === "assistant") as PiAssistantMessage;
    expect(assistantMsg).toBeDefined();
    const thinkingBlock = assistantMsg.content.find((b) => b.type === "thinking") as PiThinkingContent;
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock.thinkingSignature).toBe(SIGNATURE);
    expect(thinkingBlock.thinking).toBe(THINKING_TEXT);
  });

  it("drops the signature but keeps the thinking text on foreign replay", async () => {
    const streamSimple = vi.fn<Provider["streamSimple"]>();
    streamSimple.mockImplementationOnce(() => turn1Stream());
    streamSimple.mockImplementationOnce(() => turn2Stream());
    const models = registerFakeProvider(streamSimple);
    const port = createPiAiModelPortFromModels(models, "acme");

    const turn1Events = await collect(
      port.stream({
        model: "reasoner-1",
        messages: [{ id: "m6", role: "user", content: "what's the weather in NYC?" }],
        tools: [],
      }),
    );
    const doneEvent = turn1Events.find((e) => e.type === "done");
    const modelMeta = (doneEvent as Extract<ModelEvent, { type: "done" }>).meta;

    // The assistant message's source names a DIFFERENT model than the one
    // handling this route — a foreign replay. Signatures must be dropped.
    const req2: ModelRequest = {
      model: "reasoner-1",
      messages: buildSecondTurnMessages(modelMeta, "some-other-model"),
      tools: [],
    };
    await collect(port.stream(req2));

    expect(streamSimple).toHaveBeenCalledTimes(2);
    const [, secondContext] = streamSimple.mock.calls[1]!;
    const context = secondContext as PiContext;
    const assistantMsg = context.messages.find((m) => m.role === "assistant") as PiAssistantMessage;
    expect(assistantMsg).toBeDefined();
    const thinkingBlock = assistantMsg.content.find((b) => b.type === "thinking") as PiThinkingContent;
    expect(thinkingBlock).toBeDefined();
    // Exact equality so the assertion actually binds: no thinkingSignature
    // key at all, not merely an undefined one.
    expect(thinkingBlock).toEqual({ type: "thinking", thinking: THINKING_TEXT });
  });
});
