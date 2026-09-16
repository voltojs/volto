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
