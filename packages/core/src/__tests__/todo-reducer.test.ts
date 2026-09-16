import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { ToolDefinition } from "../tool.js";
import type { Effect } from "../effect.js";
import type { TodoItem } from "../state.js";
import { formatTodoListForModel } from "../todo-format.js";

const tools: ToolDefinition[] = [
  {
    name: "todo_write",
    description: "t",
    inputSchema: { type: "object" },
    requires: ["plan:write"],
    riskTier: "WRITE_LOW",
  },
];
const ctx: StepContext = { tools, model: "m" };

function enterExecuting(state: ReducerState): ReducerState {
  let s = step(state, { type: "user_message", content: "plan" }, ctx).state;
  s = step(s, { type: "model_chunk", chunk: { type: "text_delta", text: "ok" } }, ctx).state;
  s = step(
    s,
    {
      type: "model_chunk",
      chunk: {
        type: "tool_use_delta",
        toolCallId: "c1",
        toolCallName: "todo_write",
        argumentsDelta: "{}",
      },
    },
    ctx,
  ).state;
  s = step(s, { type: "model_done", stopReason: "tool_use" }, ctx).state;
  return s;
}

const todos: TodoItem[] = [
  { content: "step one", status: "in_progress" },
  { content: "step two", status: "pending" },
];

describe("reducer todos statePatch", () => {
  it("applies successful statePatch.todos and emits UI + reminder events once", () => {
    const base = enterExecuting(createInitialState());
    const r = step(
      base,
      {
        type: "tool_result",
        toolCallId: "c1",
        toolName: "todo_write",
        result: {
          modelContent: "Updated todo list: 1 pending, 1 in progress, 0 completed.",
          statePatch: { todos },
        },
      },
      ctx,
    );
    expect(r.state.todos).toEqual(todos);
    const emits = r.effects.filter((e): e is Extract<Effect, { type: "emit" }> => e.type === "emit");
    const todoUpdated = emits.filter((e) => e.event.type === "todoListUpdated");
    expect(todoUpdated).toHaveLength(1);
    expect(todoUpdated[0]!.event.data).toEqual({
      todos,
      counts: { pending: 1, inProgress: 1, completed: 0 },
    });
    const reminders = emits.filter(
      (e) => e.event.type === "context_reminder" && e.event.data["kind"] === "todo_list",
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.event.data["text"]).toBe(formatTodoListForModel(todos));
  });

  it("does not touch state or emit change events on isError", () => {
    const base = enterExecuting(createInitialState());
    const r = step(
      base,
      {
        type: "tool_result",
        toolCallId: "c1",
        toolName: "todo_write",
        result: {
          modelContent: "invalid",
          isError: true,
          statePatch: { todos },
        },
      },
      ctx,
    );
    expect(r.state.todos).toBeUndefined();
    const emits = r.effects.filter((e): e is Extract<Effect, { type: "emit" }> => e.type === "emit");
    expect(emits.some((e) => e.event.type === "todoListUpdated")).toBe(false);
    expect(
      emits.some(
        (e) => e.event.type === "context_reminder" && e.event.data["kind"] === "todo_list",
      ),
    ).toBe(false);
  });

  it("clears to [] on empty list patch", () => {
    // One continuous agent run: first patch writes todos, second clears.
    // After allDone the reducer re-enters calling_model, so a second
    // tool_use stretch needs no new user turn (and "done" rejects input).
    let s = enterExecuting(createInitialState());
    s = step(
      s,
      {
        type: "tool_result",
        toolCallId: "c1",
        toolName: "todo_write",
        result: { modelContent: "ok", statePatch: { todos } },
      },
      ctx,
    ).state;
    // second tool_use stretch from calling_model
    s = step(
      s,
      {
        type: "model_chunk",
        chunk: {
          type: "tool_use_delta",
          toolCallId: "c2",
          toolCallName: "todo_write",
          argumentsDelta: "{}",
        },
      },
      ctx,
    ).state;
    s = step(s, { type: "model_done", stopReason: "tool_use" }, ctx).state;
    const r = step(
      s,
      {
        type: "tool_result",
        toolCallId: "c2",
        toolName: "todo_write",
        result: { modelContent: "cleared", statePatch: { todos: [] } },
      },
      ctx,
    );
    expect(r.state.todos).toEqual([]);
    // Clear is still a successful patch: UI event + reminder must fire so
    // UIs/assemblers observe the wipe. formatTodoListForModel([]) is "".
    const emits = r.effects.filter((e): e is Extract<Effect, { type: "emit" }> => e.type === "emit");
    const todoUpdated = emits.filter((e) => e.event.type === "todoListUpdated");
    expect(todoUpdated).toHaveLength(1);
    expect(todoUpdated[0]!.event.data).toEqual({
      todos: [],
      counts: { pending: 0, inProgress: 0, completed: 0 },
    });
    const reminders = emits.filter(
      (e) => e.event.type === "context_reminder" && e.event.data["kind"] === "todo_list",
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.event.data["text"]).toBe(formatTodoListForModel([]));
    expect(formatTodoListForModel([])).toBe("");
  });

  it("ignores unknown statePatch keys", () => {
    const base = enterExecuting(createInitialState());
    const r = step(
      base,
      {
        type: "tool_result",
        toolCallId: "c1",
        toolName: "todo_write",
        result: {
          modelContent: "ok",
          statePatch: { todos, extra: "nope" } as never,
        },
      },
      ctx,
    );
    expect(r.state.todos).toEqual(todos);
  });

  it("replay: same tool_result sequence yields identical todos and emits", () => {
    const inputs = [
      { type: "user_message" as const, content: "plan" },
      { type: "model_chunk" as const, chunk: { type: "text_delta" as const, text: "ok" } },
      {
        type: "model_chunk" as const,
        chunk: {
          type: "tool_use_delta" as const,
          toolCallId: "c1",
          toolCallName: "todo_write",
          argumentsDelta: "{}",
        },
      },
      { type: "model_done" as const, stopReason: "tool_use" as const },
      {
        type: "tool_result" as const,
        toolCallId: "c1",
        toolName: "todo_write",
        result: { modelContent: "ok", statePatch: { todos } },
      },
    ];
    function run() {
      let s = createInitialState();
      const emits: string[] = [];
      for (const input of inputs) {
        const r = step(s, input, ctx);
        s = r.state;
        for (const e of r.effects) {
          if (e.type === "emit") emits.push(`${e.event.type}:${JSON.stringify(e.event.data)}`);
        }
      }
      return { todos: s.todos, emits };
    }
    expect(run()).toEqual(run());
  });
});
