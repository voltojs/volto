import { describe, it, expect } from "vitest";
import { toOpenAiMessages } from "../model-port.js";
import type { Message } from "@volto/core";

function img(data: string) {
  return { type: "image" as const, source: { type: "base64" as const, mediaType: "image/png", data } };
}

const twoToolResultsWithImages = [
  { id: "m0", role: "user", content: "compare the two charts" },
  {
    id: "m1",
    role: "assistant",
    content: [
      { type: "tool_use", id: "call-a", name: "read_file", input: {} },
      { type: "tool_use", id: "call-b", name: "read_file", input: {} },
    ],
  },
  {
    id: "m2",
    role: "tool",
    content: [
      { type: "tool_result", toolUseId: "call-a", content: [{ type: "text", text: "first" }, img("AAA")] },
      { type: "tool_result", toolUseId: "call-b", content: [{ type: "text", text: "second" }, img("BBB")] },
    ],
  },
] as unknown as Message[];

describe("openai image split", () => {
  it("keeps tool messages textual and notes the image", () => {
    const out = toOpenAiMessages(twoToolResultsWithImages) as Array<Record<string, unknown>>;
    const toolMsgs = out.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(typeof toolMsgs[0]!.content).toBe("string");
    expect(toolMsgs[0]!.content as string).toContain("first");
    expect(toolMsgs[0]!.content as string).toContain("image");
  });

  it("merges every image of the batch into exactly one user message", () => {
    const out = toOpenAiMessages(twoToolResultsWithImages) as Array<Record<string, unknown>>;
    const carriers = out.filter(
      (m) => m.role === "user" && Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).some((p) => p.type === "image_url"),
    );
    expect(carriers).toHaveLength(1);
    const parts = carriers[0]!.content as Array<Record<string, unknown>>;
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(2);
  });

  it("labels each image with the tool call it came from", () => {
    const out = toOpenAiMessages(twoToolResultsWithImages) as Array<Record<string, unknown>>;
    const carrier = out.find(
      (m) => m.role === "user" && Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).some((p) => p.type === "image_url"),
    )!;
    const text = (carrier.content as Array<Record<string, unknown>>)
      .filter((p) => p.type === "text")
      .map((p) => p.text as string)
      .join(" ");
    expect(text).toContain("call-a");
    expect(text).toContain("call-b");
  });

  it("places the image carrier directly after the tool batch", () => {
    const out = toOpenAiMessages(twoToolResultsWithImages) as Array<Record<string, unknown>>;
    const lastToolIdx = out.map((m) => m.role).lastIndexOf("tool");
    expect(out[lastToolIdx + 1]!.role).toBe("user");
  });

  it("is deterministic", () => {
    expect(JSON.stringify(toOpenAiMessages(twoToolResultsWithImages)))
      .toBe(JSON.stringify(toOpenAiMessages(twoToolResultsWithImages)));
  });
});

// D3 matrix (spec §2): the Chat Completions tool role accepts string content
// only, so structured blocks degrade to their text projection and join the
// string in order — an explicit branch, not a silent fall through the
// text-only filter.
describe("openai structured block degradation", () => {
  const projection = '{"locations":[{"uri":"file:///a.ts"}]}';
  const structured = {
    type: "structured" as const,
    kind: "lsp.locations",
    data: { locations: [{ uri: "file:///a.ts" }] },
    text: projection,
  };

  function toolMessageFor(content: unknown[]): Record<string, unknown> {
    const messages = [
      { id: "m1", role: "assistant", content: [] },
      { id: "m2", role: "tool", content: [{ type: "tool_result", toolUseId: "call-1", content }] },
    ] as unknown as Message[];
    const out = toOpenAiMessages(messages) as Array<Record<string, unknown>>;
    return out.find((m) => m.role === "tool")!;
  }

  it("joins the structured text projection into the tool message string", () => {
    const msg = toolMessageFor([structured]);
    expect(typeof msg.content).toBe("string");
    expect(msg.content as string).toContain(projection);
  });

  it("keeps [text, structured, text] in order joined by newlines", () => {
    const msg = toolMessageFor([
      { type: "text", text: "before" },
      structured,
      { type: "text", text: "after" },
    ]);
    expect(msg.content).toBe(`before\n${projection}\nafter`);
  });

  // Counter-proof: a tool_result whose ONLY block is structured must not fall
  // into the unknown-type default (an empty string would silently drop it).
  it("does not drop a tool_result whose only block is structured", () => {
    const msg = toolMessageFor([structured]);
    const content = msg.content as string;
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain(projection);
  });
});
