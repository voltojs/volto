import type { EventSink, ToolResult } from "@agent-core/core";
import { z } from "zod";
import { defineFileTool } from "@agent-core/tools-fs";
import { CAP_PLAN_WRITE } from "./capabilities.js";

const todoItemSchema = z.object({
  id: z.string().describe("Unique todo identifier"),
  content: z.string().describe("Todo item description"),
  status: z
    .enum(["pending", "in_progress", "completed"])
    .describe("Current status of the todo item"),
});

export const writeTodosSchema = z.object({
  todos: z
    .array(todoItemSchema)
    .describe("The complete updated todo list after applying changes"),
});

export type TodoItem = z.infer<typeof todoItemSchema>;

export function createWriteTodosTool(eventSink?: EventSink) {
  return defineFileTool({
    name: "write_todos",
    description:
      "Write or update the project todo list. Pass the complete updated list each time. Emits a todoListUpdated event.",
    schema: writeTodosSchema,
    requires: [CAP_PLAN_WRITE],
    riskTier: "WRITE_LOW",
    run: async (input): Promise<ToolResult> => {
      const { todos } = input;

      const summary = todos
        .map((t) => {
          const icon =
            t.status === "completed"
              ? "[x]"
              : t.status === "in_progress"
                ? "[~]"
                : "[ ]";
          return `${icon} ${t.id}: ${t.content}`;
        })
        .join("\n");

      eventSink?.emit({
        type: "todoListUpdated",
        data: { todos },
      });

      const completed = todos.filter((t) => t.status === "completed").length;

      return {
        modelContent: `Todo list updated (${completed}/${todos.length} completed):\n${summary}`,
        displayMetadata: {
          todos,
          completedCount: completed,
          totalCount: todos.length,
        },
      };
    },
  });
}
