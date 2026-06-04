import type { ToolResult } from "@agent-core/core";
import { z } from "zod";
import { defineTool } from "@agent-core/tools-common";
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

export function createWriteTodosTool() {
  return defineTool({
    name: "write_todos",
    description:
      "Write or update the project todo list. Pass the complete updated list each time.",
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

      const completed = todos.filter((t) => t.status === "completed").length;

      // Emit the todoListUpdated event via the effect channel (pendingEvents).
      // The Runner reads these and forwards them to the EventSink, keeping the
      // tool itself side-effect-free and fully replayable.
      const pendingEvents = [{ type: "todoListUpdated", data: { todos } }];

      return {
        modelContent: `Todo list updated (${completed}/${todos.length} completed):\n${summary}`,
        displayMetadata: {
          todos,
          completedCount: completed,
          totalCount: todos.length,
          pendingEvents,
        },
      };
    },
  });
}
