import { describe, it, expect } from "vitest";
import { formatTodoListForModel, formatTodoCounts } from "../todo-format.js";
import type { TodoItem } from "../state.js";

const list: TodoItem[] = [
  { content: "wire reducer statePatch", status: "in_progress" },
  { content: "assemble todo layer", status: "pending" },
  { content: "design types", status: "completed" },
];

describe("formatTodoListForModel", () => {
  it("emits a stable header and one checkbox line per item in order", () => {
    expect(formatTodoListForModel(list)).toBe(
      [
        "Current todo list (authoritative for this session; older todo_write tool history may be compressed away):",
        "- [~] wire reducer statePatch",
        "- [ ] assemble todo layer",
        "- [x] design types",
      ].join("\n"),
    );
  });

  it("returns empty string for empty list", () => {
    expect(formatTodoListForModel([])).toBe("");
  });
});

describe("formatTodoCounts", () => {
  it("counts by status", () => {
    expect(formatTodoCounts(list)).toBe(
      "Updated todo list: 1 pending, 1 in progress, 1 completed.",
    );
  });
});
