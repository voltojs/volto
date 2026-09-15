import { describe, it, expect } from "vitest";
import { assembleContext } from "../context-assembler.js";
import { formatTodoListForModel } from "../todo-format.js";
import type { Message, TodoItem } from "../state.js";
import type { ToolDefinition } from "../tool.js";

const tools: ToolDefinition[] = [];
const sys: Message = { id: "s1", role: "system", content: "base" };
const user: Message = { id: "u1", role: "user", content: "go" };
const todos: TodoItem[] = [
  { content: "a", status: "in_progress" },
  { content: "b", status: "pending" },
];

describe("assembleContext todos layer", () => {
  it("injects todo-list after contextLayers and before pinned", () => {
    const pinned: Message = { id: "p1", role: "user", content: "pinned" };
    const result = assembleContext({
      messages: [sys, user, pinned],
      tools,
      pinnedMessageIds: ["p1"],
      contextLayers: [{ id: "user-memory", text: "mem" }],
      todos,
    });
    const ids = result.messages.map((m) => m.id);
    expect(ids).toEqual(["s1", "layer-user-memory", "layer-todo-list", "p1", "u1"]);
    const todoMsg = result.messages[2]!;
    expect(todoMsg.role).toBe("system");
    expect(todoMsg.content).toBe(formatTodoListForModel(todos));
    expect(result.layerOrigins.some((l) => l.id === "todo-list")).toBe(true);
  });

  it("skips injection for undefined or empty todos", () => {
    expect(
      assembleContext({ messages: [sys, user], tools, todos: [] }).messages.some(
        (m) => m.id === "layer-todo-list",
      ),
    ).toBe(false);
    expect(
      assembleContext({ messages: [sys, user], tools }).messages.some(
        (m) => m.id === "layer-todo-list",
      ),
    ).toBe(false);
  });
});
