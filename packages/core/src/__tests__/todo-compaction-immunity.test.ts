import { describe, it, expect } from "vitest";
import { assembleContext } from "../context-assembler.js";
import { formatTodoListForModel } from "../todo-format.js";
import type { Message, TodoItem } from "../state.js";

describe("todos survive message compaction", () => {
  it("injects the latest list even when historical tool messages are gone", () => {
    const todos: TodoItem[] = [{ content: "keep me", status: "in_progress" }];
    const messages: Message[] = [
      { id: "s", role: "system", content: "sys" },
      { id: "u", role: "user", content: "start" },
      // history that would have carried the tool call is absent — already compacted away
    ];
    const assembled = assembleContext({ messages, tools: [], todos });
    const texts = assembled.messages.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
    expect(texts).toContain(formatTodoListForModel(todos));
  });
});
