import { describe, it, expect } from "vitest";
import { extractMessageText, extractBlockText, extractPlainText } from "../text-extract.js";
import type { Message } from "../state.js";

describe("extractMessageText", () => {
  it("extracts string content", () => {
    const msg: Message = { id: "m1", role: "user", content: "Hello world" };
    expect(extractMessageText(msg)).toBe("Hello world");
  });

  it("extracts text blocks", () => {
    const msg: Message = {
      id: "m2",
      role: "assistant",
      content: [{ type: "text", text: "Response" }],
    };
    expect(extractMessageText(msg)).toBe("Response");
  });

  it("extracts tool_use blocks as placeholder", () => {
    const msg: Message = {
      id: "m3",
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }],
    };
    expect(extractMessageText(msg)).toBe("[tool: read_file]");
  });

  it("extracts tool_result blocks", () => {
    const msg: Message = {
      id: "m4",
      role: "tool",
      content: [{ type: "tool_result", toolUseId: "t1", content: [{ type: "text", text: "file data" }] }],
    };
    expect(extractMessageText(msg)).toBe("file data");
  });

  it("handles mixed content blocks", () => {
    const msg: Message = {
      id: "m5",
      role: "assistant",
      content: [
        { type: "text", text: "Let me read the file:" },
        { type: "tool_use", id: "t1", name: "read_file", input: {} },
      ],
    };
    expect(extractMessageText(msg)).toBe("Let me read the file:\n[tool: read_file]");
  });

  it("handles empty content array", () => {
    const msg: Message = { id: "m6", role: "assistant", content: [] };
    expect(extractMessageText(msg)).toBe("");
  });

  it("handles image content as empty string", () => {
    const msg: Message = {
      id: "m7",
      role: "user",
      content: [{ type: "image", source: { type: "ref", id: "att-1", mediaType: "image/png" } }],
    };
    expect(extractMessageText(msg)).toBe("");
  });
});

describe("extractBlockText", () => {
  it("extracts text block", () => {
    expect(extractBlockText({ type: "text", text: "hello" })).toBe("hello");
  });

  it("extracts tool_use block", () => {
    expect(extractBlockText({ type: "tool_use", id: "t1", name: "bash", input: {} })).toBe("[tool: bash]");
  });

  it("extracts tool_result block", () => {
    expect(extractBlockText({ type: "tool_result", toolUseId: "t1", content: [{ type: "text", text: "output" }] })).toBe("output");
  });

  it("handles image block as empty", () => {
    expect(extractBlockText({ type: "image", source: { type: "ref", id: "att-2", mediaType: "image/png" } })).toBe("");
  });
});

describe("extractPlainText", () => {
  it("extracts only text blocks from mixed content", () => {
    const msg: Message = {
      id: "m8",
      role: "assistant",
      content: [
        { type: "text", text: "Here:" },
        { type: "tool_use", id: "t1", name: "bash", input: {} },
        { type: "text", text: "Done" },
      ],
    };
    expect(extractPlainText(msg)).toBe("Here:Done");
  });

  it("extracts string content", () => {
    const msg: Message = { id: "m9", role: "user", content: "Hello" };
    expect(extractPlainText(msg)).toBe("Hello");
  });

  it("returns empty for tool-only content", () => {
    const msg: Message = {
      id: "m10",
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
    };
    expect(extractPlainText(msg)).toBe("");
  });
});

describe("reasoning content block extraction", () => {
  it("extracts to empty string (not user-facing)", () => {
    expect(extractBlockText({ type: "reasoning", text: "let me think" })).toBe("");
  });

  it("is dropped cleanly when joined in multi-block messages", () => {
    const msg: Message = {
      id: "m11",
      role: "assistant",
      content: [
        { type: "reasoning", text: "let me think" },
        { type: "text", text: "answer" },
      ],
    };
    expect(extractPlainText(msg)).toBe("answer");
  });
});
