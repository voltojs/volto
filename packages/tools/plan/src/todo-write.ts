import type { ToolResult } from "@voltojs/core";
import { z } from "zod";
import { defineTool } from "@voltojs/tools-common";
import { CAP_PLAN_WRITE } from "./capabilities.js";

const todoItemSchema = z
  .object({
    content: z.string().describe("What the task is — a short imperative line."),
    status: z
      .enum(["pending", "in_progress", "completed"])
      .describe("pending (not started) | in_progress (now) | completed (done)."),
  })
  .strict();

const todoWriteSchema = z
  .object({
    todos: z
      .array(todoItemSchema)
      .describe("The COMPLETE task list, replacing any previous list."),
  })
  .strict();

const DESCRIPTION =
  "Record and update a structured task list for the current work. " +
  "Send the ENTIRE list every call — it REPLACES the previous list (no partial updates, no per-item edits). " +
  "Use it to plan multi-step work and show progress: add one todo per concrete step before you start. " +
  "Mark a todo in_progress while you work it (at most one unless the deployment allows parallel work), " +
  "and completed the moment it is done (do not batch completions). " +
  "When all work is finished you may send an empty list to clear the plan. " +
  "Skip the list for trivial single-step tasks.";

export interface TodoWriteToolOptions {
  /** When set, more than this many `in_progress` items are rejected. Omitted = unlimited. */
  maxInProgress?: number;
}

export function createTodoWriteTool(opts: TodoWriteToolOptions = {}) {
  const maxInProgress = opts.maxInProgress;
  return defineTool({
    name: "todo_write",
    description: DESCRIPTION,
    schema: todoWriteSchema,
    requires: [CAP_PLAN_WRITE],
    // The todo list is session state, not a workspace file.
    riskTier: "READ_ONLY",
    writesSessionState: true,
    run: async (input): Promise<ToolResult> => {
      const seen = new Set<string>();
      const todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> = [];
      let inProgress = 0;
      for (const item of input.todos) {
        const content = item.content.trim();
        if (content.length === 0) {
          return {
            modelContent: "Error: invalid todo: `content` must be a non-empty string",
            isError: true,
          };
        }
        if (seen.has(content)) {
          return {
            modelContent: `Error: invalid todos: duplicate content ${JSON.stringify(content)}`,
            isError: true,
          };
        }
        seen.add(content);
        if (item.status === "in_progress") inProgress++;
        todos.push({ content, status: item.status });
      }
      if (maxInProgress !== undefined && inProgress > maxInProgress) {
        return {
          modelContent: `Error: invalid todos: at most ${maxInProgress} task(s) may be in_progress (got ${inProgress})`,
          isError: true,
        };
      }
      const counts = {
        pending: todos.filter((t) => t.status === "pending").length,
        inProgress,
        completed: todos.filter((t) => t.status === "completed").length,
      };
      return {
        modelContent: `Updated todo list: ${counts.pending} pending, ${counts.inProgress} in progress, ${counts.completed} completed.`,
        statePatch: { todos },
        displayMetadata: { todos, counts },
      };
    },
  });
}
