import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import {
  createMockModelPort,
  textScript,
  toolCallScript,
  formatTodoListForModel,
  TODO_LIST_LAYER_ID,
} from "@voltojs/core";
import type { EventSink, ModelPort, ModelRequest, Message } from "@voltojs/core";

/**
 * End-to-end smoke for the standing-todo pipeline:
 * model todo_write → state.todos → EventSink → next request injects layer.
 */

function capturingPort(
  script: Parameters<typeof createMockModelPort>[0],
  requests: ModelRequest[],
): ModelPort {
  const inner = createMockModelPort(script);
  return {
    async *stream(req) {
      requests.push(structuredClone(req));
      yield* inner.stream(req);
    },
  };
}

function collectingSink(): { sink: EventSink; events: Array<{ type: string; data: Record<string, unknown> }> } {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  return {
    sink: { emit: (e) => events.push({ type: e.type, data: e.data }) },
    events,
  };
}

function messageTexts(messages: readonly Message[]): string[] {
  return messages.map((m) =>
    typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  );
}

describe("agent todos end-to-end smoke", () => {
  const list = [
    { content: "read the spec", status: "completed" as const },
    { content: "implement the patch", status: "in_progress" as const },
    { content: "write the tests", status: "pending" as const },
  ];

  it("write → state.todos + todoListUpdated + inject layer on the next call", async () => {
    const requests: ModelRequest[] = [];
    const { sink, events } = collectingSink();
    const modelPort = capturingPort(
      [
        toolCallScript("c1", "todo_write", JSON.stringify({ todos: list })),
        textScript("plan recorded"),
        textScript("continuing"),
      ],
      requests,
    );

    const agent = createAgent({ modelPort, eventSink: sink });

    const state1 = await agent.run("plan a three-step task");
    expect(state1.status).toBe("done");
    expect(state1.todos).toEqual(list);

    const updates = events.filter((e) => e.type === "todoListUpdated");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.data["todos"]).toEqual(list);

    const reminders = events.filter(
      (e) => e.type === "context_reminder" && e.data["kind"] === "todo_list",
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.data["text"]).toBe(formatTodoListForModel(list));

    // First model call has no standing list yet (never written).
    expect(messageTexts(requests[0]!.messages).some((t) => t.includes(TODO_LIST_LAYER_ID))).toBe(
      false,
    );

    // Second model call (after the tool result, still in the same turn or next)
    // must carry the injected standing list.
    const later = requests[requests.length - 1]!;
    expect(messageTexts(later.messages).some((t) => t.includes(formatTodoListForModel(list)))).toBe(
      true,
    );

    // Subsequent user turn still injects from state (session-level standing plan).
    const state2 = await agent.run("what is next?");
    expect(state2.status).toBe("done");
    expect(state2.todos).toEqual(list);
    const last = requests[requests.length - 1]!;
    expect(messageTexts(last.messages).some((t) => t.includes(formatTodoListForModel(list)))).toBe(
      true,
    );
  });

  it("clearing to [] removes the injected layer on later calls", async () => {
    const requests: ModelRequest[] = [];
    const { sink, events } = collectingSink();
    // One tool_use per model call: c1 write → (tool result) → c2 clear → text.
    const modelPort = capturingPort(
      [
        toolCallScript("c1", "todo_write", JSON.stringify({ todos: list })),
        toolCallScript("c2", "todo_write", JSON.stringify({ todos: [] })),
        textScript("cleared"),
      ],
      requests,
    );

    const agent = createAgent({ modelPort, eventSink: sink });
    const state = await agent.run("plan then clear");
    expect(state.todos).toEqual([]);

    const clears = events.filter(
      (e) =>
        e.type === "todoListUpdated" &&
        Array.isArray(e.data["todos"]) &&
        (e.data["todos"] as unknown[]).length === 0,
    );
    expect(clears).toHaveLength(1);

    const last = requests[requests.length - 1]!;
    expect(messageTexts(last.messages).some((t) => t.includes(formatTodoListForModel(list)))).toBe(
      false,
    );
    expect(messageTexts(last.messages).some((t) => t.includes(TODO_LIST_LAYER_ID))).toBe(false);
  });

  it("invalid todo_write does not mutate state.todos", async () => {
    const requests: ModelRequest[] = [];
    const modelPort = capturingPort(
      [
        toolCallScript(
          "c1",
          "todo_write",
          JSON.stringify({ todos: [{ content: "   ", status: "pending" }] }),
        ),
        textScript("failed"),
      ],
      requests,
    );
    const agent = createAgent({ modelPort });
    const state = await agent.run("try invalid");
    expect(state.status).toBe("done");
    expect(state.todos).toBeUndefined();
  });
});
