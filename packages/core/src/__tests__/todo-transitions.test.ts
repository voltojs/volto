import { describe, expect, it } from "vitest";
import { diffTodoSnapshots, foldTodoTransitions } from "../todo-format.js";
import type { TodoItem } from "../state.js";

const t = (content: string, status: TodoItem["status"]): TodoItem => ({ content, status });

describe("diffTodoSnapshots", () => {
  it("returns nothing without a baseline or without change", () => {
    expect(diffTodoSnapshots(null, [t("a", "in_progress")])).toEqual([]);
    expect(diffTodoSnapshots([t("a", "pending")], [t("a", "pending")])).toEqual([]);
  });

  it("covers add, start, complete, reopen and remove", () => {
    const prev = [
      t("a", "pending"),
      t("b", "in_progress"),
      t("c", "completed"),
      t("d", "pending"),
    ];
    const next = [t("a", "in_progress"), t("b", "completed"), t("c", "pending")];
    expect(diffTodoSnapshots(prev, next)).toEqual([
      { kind: "completed", content: "b" },
      { kind: "reopened", content: "c" },
      { kind: "started", content: "a" },
      { kind: "removed", content: "d" },
    ]);
  });

  it("emits added before started/completed for a brand-new item but keeps phase order", () => {
    expect(diffTodoSnapshots([], [t("x", "in_progress"), t("y", "completed")])).toEqual([
      { kind: "completed", content: "y" },
      { kind: "started", content: "x" },
      { kind: "added", content: "x" },
      { kind: "added", content: "y" },
    ]);
  });
});

describe("foldTodoTransitions", () => {
  const ev = (time: number, todos: unknown[], turn = 1) => ({
    type: "todoListUpdated",
    data: { todos },
    time,
    turn,
  });

  it("uses the initial snapshot as the diff baseline", () => {
    const seed = [t("a", "in_progress")];
    const records = foldTodoTransitions([ev(200, [t("a", "completed")])], seed);
    expect(records).toEqual([
      { turn: 1, time: 200, transition: { kind: "completed", content: "a" } },
    ]);
  });

  it("emits nothing for the first snapshot when there is no seed", () => {
    expect(foldTodoTransitions([ev(100, [t("a", "pending")])], null)).toEqual([]);
  });

  it("ignores malformed snapshots", () => {
    expect(
      foldTodoTransitions([{ type: "todoListUpdated", data: { todos: "nope" } }], null),
    ).toEqual([]);
  });
});
