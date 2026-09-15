import { describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";

// This test pins facts about the pi-ai (@earendil-works/pi-ai) API surface that
// later tasks in this plan rely on. It is not testing volto code — it is testing
// pi-ai's own behavior, so that a pi-ai upgrade which changes these facts fails
// here first, before it silently breaks assumptions baked into later tasks.
//
// No API key is required: fauxProvider() is a fully in-memory scripted provider.

describe("pi-ai surface pinning", () => {
  it("streamSimple emits the expected event sequence with thinking + toolCall content", async () => {
    const faux = fauxProvider();
    const model = faux.getModel();

    faux.setResponses([
      fauxAssistantMessage(
        [fauxThinking("Let me think about this."), fauxToolCall("echo", { text: "hi" })],
        { stopReason: "toolUse" },
      ),
    ]);

    const context = {
      messages: [{ id: "m1", role: "user" as const, content: "hello", timestamp: Date.now() }],
    };

    // Drive the faux provider directly (no `createModels()`/`setProvider` needed)
    // to keep this test scoped to the raw pi-ai surface.
    const stream = faux.provider.streamSimple(model, context);

    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const types = events.map((e) => e.type);

    // Full event sequence must start with "start" and end with "done".
    expect(types[0]).toBe("start");
    expect(types.at(-1)).toBe("done");

    // The two event kinds later tasks depend on for thinking + tool-call replay.
    expect(types).toContain("thinking_delta");
    expect(types).toContain("toolcall_end");

    // "done" carries the final message under `message`, not `assistantMessage`.
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent?.type !== "done") throw new Error("unreachable");

    const finalMessage = doneEvent.message;
    expect(finalMessage.role).toBe("assistant");
    expect(finalMessage.stopReason).toBe("toolUse");

    // Content block field names: `thinking`/`thinkingSignature` on ThinkingContent,
    // `name`/`arguments`/`thoughtSignature` on ToolCall (not "toolCallSignature").
    const thinkingBlock = finalMessage.content.find((b) => b.type === "thinking");
    expect(thinkingBlock).toBeDefined();
    if (thinkingBlock?.type !== "thinking") throw new Error("unreachable");
    expect(typeof thinkingBlock.thinking).toBe("string");
    expect(thinkingBlock.thinking.length).toBeGreaterThan(0);
    // fauxThinking() does not set a signature; the field is simply absent (not present as a key).
    expect(thinkingBlock).not.toHaveProperty("thinkingSignature");

    const toolCallBlock = finalMessage.content.find((b) => b.type === "toolCall");
    expect(toolCallBlock).toBeDefined();
    if (toolCallBlock?.type !== "toolCall") throw new Error("unreachable");
    expect(toolCallBlock.name).toBe("echo");
    expect(toolCallBlock.arguments).toEqual({ text: "hi" });
    expect(typeof toolCallBlock.id).toBe("string");

    // toolcall_end event exposes the same ToolCall under `toolCall`, not `content`.
    const toolcallEndEvent = events.find((e) => e.type === "toolcall_end");
    expect(toolcallEndEvent).toBeDefined();
    if (toolcallEndEvent?.type !== "toolcall_end") throw new Error("unreachable");
    expect(toolcallEndEvent.toolCall.name).toBe("echo");
  });

  it("fauxAssistantMessage produces a Usage object with the recorded field names", () => {
    const message = fauxAssistantMessage("hello world");

    expect(message.usage).toBeDefined();
    expect(typeof message.usage.input).toBe("number");
    expect(typeof message.usage.output).toBe("number");
    expect(typeof message.usage.cacheRead).toBe("number");
    expect(typeof message.usage.cacheWrite).toBe("number");
    expect(typeof message.usage.totalTokens).toBe("number");
    expect(message.usage.cost).toBeDefined();
    expect(typeof message.usage.cost.input).toBe("number");
    expect(typeof message.usage.cost.output).toBe("number");
    expect(typeof message.usage.cost.cacheRead).toBe("number");
    expect(typeof message.usage.cost.cacheWrite).toBe("number");
    expect(typeof message.usage.cost.total).toBe("number");

    // A text-only fauxAssistantMessage has a plain text content block.
    const textBlock = message.content.find((b) => b.type === "text");
    expect(textBlock).toBeDefined();
    if (textBlock?.type !== "text") throw new Error("unreachable");
    expect(textBlock.text).toBe("hello world");
  });

  it("fauxText/fauxThinking/fauxToolCall build content blocks with the recorded field names", () => {
    const text = fauxText("hi");
    expect(text).toEqual({ type: "text", text: "hi" });

    const thinking = fauxThinking("thinking...");
    expect(thinking).toEqual({ type: "thinking", thinking: "thinking..." });

    const toolCall = fauxToolCall("read_file", { path: "a.txt" });
    expect(toolCall.type).toBe("toolCall");
    expect(toolCall.name).toBe("read_file");
    expect(toolCall.arguments).toEqual({ path: "a.txt" });
    expect(typeof toolCall.id).toBe("string");
  });
});
