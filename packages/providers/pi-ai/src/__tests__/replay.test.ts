import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { readReplayEnvelope, toReplayEnvelope } from "../replay.js";

// The replay envelope is an adapter-private, pure-JSON blob that carries pi-ai's
// per-block replay signatures (textSignature / thinkingSignature / thoughtSignature)
// through core's neutral AssistantMessage representation and back. Core never
// reads it; it round-trips through a JSONL transcript store across processes.

describe("replay envelope", () => {
  const model = "test-model";

  function buildMessage() {
    const thinking = { ...fauxThinking("Let me think."), thinkingSignature: "thinking-sig" };
    const text = { ...fauxText("hello"), textSignature: "text-sig" };
    const toolCall = { ...fauxToolCall("echo", { text: "hi" }), thoughtSignature: "tool-sig" };
    return fauxAssistantMessage([thinking, text, toolCall], { stopReason: "toolUse" });
  }

  it("toReplayEnvelope produces a block-aligned envelope with signatures in place", () => {
    const message = buildMessage();

    const envelope = toReplayEnvelope(message, model);

    expect(envelope).toEqual({
      version: 1,
      model,
      blocks: [
        { type: "reasoning", thinkingSignature: "thinking-sig" },
        { type: "text", textSignature: "text-sig" },
        { type: "tool_use", thoughtSignature: "tool-sig" },
      ],
    });
  });

  it("is pure JSON: survives a JSON.parse(JSON.stringify(...)) round trip unchanged", () => {
    const message = buildMessage();
    const envelope = toReplayEnvelope(message, model);

    const roundTripped = JSON.parse(JSON.stringify(envelope));

    expect(roundTripped).toEqual(envelope);
  });

  it("readReplayEnvelope returns undefined for a foreign model", () => {
    const message = buildMessage();
    const envelope = toReplayEnvelope(message, model);

    expect(readReplayEnvelope(envelope, "other-model")).toBeUndefined();
  });

  it("readReplayEnvelope returns undefined for malformed input without throwing", () => {
    expect(readReplayEnvelope({}, model)).toBeUndefined();
    expect(readReplayEnvelope(null, model)).toBeUndefined();
    expect(readReplayEnvelope(undefined, model)).toBeUndefined();
    expect(readReplayEnvelope("not an object", model)).toBeUndefined();
    expect(readReplayEnvelope({ version: 1, model, blocks: "not an array" }, model)).toBeUndefined();
    expect(
      readReplayEnvelope({ version: 1, model, blocks: [{ type: "bogus" }] }, model),
    ).toBeUndefined();
    expect(readReplayEnvelope({ version: 2, model, blocks: [] }, model)).toBeUndefined();
  });

  it("round-trips through toReplayEnvelope -> readReplayEnvelope unchanged", () => {
    const message = buildMessage();
    const envelope = toReplayEnvelope(message, model);

    const recovered = readReplayEnvelope(envelope, model);

    expect(recovered).toEqual(envelope);
  });

  it("preserves the redacted flag on reasoning blocks when present", () => {
    const thinking = { type: "thinking" as const, thinking: "", redacted: true };
    const message = fauxAssistantMessage([thinking]);

    const envelope = toReplayEnvelope(message, model);

    expect(envelope.blocks).toEqual([{ type: "reasoning", redacted: true }]);
  });

  it("omits absent signature fields rather than writing them as undefined", () => {
    const message = fauxAssistantMessage([fauxText("hi")]);

    const envelope = toReplayEnvelope(message, model);

    expect(envelope.blocks[0]).toEqual({ type: "text" });
    expect(Object.keys(envelope.blocks[0]!)).toEqual(["type"]);
  });
});
