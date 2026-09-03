import { describe, it, expect } from "vitest";
import { toUiMessages } from "../transcript-view.js";
import type { Message } from "@volto/core";

describe("toUiMessages", () => {
  it("drops system messages", () => {
    const messages: Message[] = [
      { role: "system", content: "you are a helpful assistant" },
      { role: "user", content: "hi" },
    ];
    const ui = toUiMessages("s1", messages, [0, 1]);
    expect(ui).toEqual([{ id: "s1-1", role: "user", content: "hi", timestamp: 1 }]);
  });

  it("flattens assistant text content blocks into a plain string", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "part one " },
          { type: "text", text: "part two" },
        ],
      },
    ];
    const ui = toUiMessages("s1", messages, [5]);
    expect(ui).toEqual([
      { id: "s1-0", role: "assistant", content: "part one part two", timestamp: 5 },
    ]);
  });

  it("folds a later tool-result message into the matching tool_use call", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "call-1", name: "read_file", input: { path: "/a.ts" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolUseId: "call-1", content: "file contents" }],
      },
    ];
    const ui = toUiMessages("s1", messages, [0, 1]);

    // The tool-result message produces no entry of its own.
    expect(ui).toHaveLength(1);
    expect(ui[0]).toEqual({
      id: "s1-0",
      role: "assistant",
      content: "let me check",
      timestamp: 0,
      toolCalls: [
        { id: "call-1", name: "read_file", args: { path: "/a.ts" }, result: "file contents", isError: undefined },
      ],
    });
  });

  it("marks a failed tool call via isError", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "run_shell", input: {} }],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolUseId: "call-1", content: "boom", isError: true }],
      },
    ];
    const ui = toUiMessages("s1", messages, [0, 1]);
    expect(ui[0]!.toolCalls![0]!.isError).toBe(true);
  });
});
