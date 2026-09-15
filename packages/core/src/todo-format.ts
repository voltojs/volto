import type { TodoItem } from "./state.js";

/** Icon for one status. Shared by injection and (if needed) future UIs. */
export function todoStatusIcon(status: TodoItem["status"]): string {
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[~]";
  return "[ ]";
}

/**
 * Canonical model-facing standing-list text. Sole producer of the injection
 * layer body and `context_reminder` kind `todo_list`.
 */
export function formatTodoListForModel(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return "";
  const header =
    "Current todo list (authoritative for this session; older todo_write tool history may be compressed away):";
  const lines = todos.map((t) => `- ${todoStatusIcon(t.status)} ${t.content}`);
  return [header, ...lines].join("\n");
}

/** Counts line for tool/model acks (core helper; tools may reimplement locally). */
export function formatTodoCounts(todos: readonly TodoItem[]): string {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const t of todos) {
    if (t.status === "pending") pending++;
    else if (t.status === "in_progress") inProgress++;
    else completed++;
  }
  return `Updated todo list: ${pending} pending, ${inProgress} in progress, ${completed} completed.`;
}
