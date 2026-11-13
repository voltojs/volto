import { describe, it, expect, vi } from "vitest";
import { createAgent } from "../create-agent.js";
import {
  modelDone,
  textScript,
  toolUseDelta,
  toolUseStart,
} from "@voltojs/core";
import type { ModelEvent, ModelPort, ModelRequest, TranscriptEventInput } from "@voltojs/core";

function fakeChatStore() {
  const bySession = new Map<string, TranscriptEventInput[]>();
  return {
    bySession,
    store: {
      async appendEvents(sessionId: string, events: TranscriptEventInput[]) {
        const list = bySession.get(sessionId) ?? [];
        list.push(...events);
        bySession.set(sessionId, list);
      },
    },
  };
}

function twice(callA: string, callB: string): ModelEvent[] {
  return [
    toolUseStart("call-a", "task"),
    toolUseDelta("call-a", callA),
    toolUseStart("call-b", "task"),
    toolUseDelta("call-b", callB),
    modelDone("tool_use"),
  ];
}

/** Route by the child's dispatch message so detached work cannot reorder the parent scripts. */
function routedPort(opts: {
  children: Readonly<Record<string, ModelEvent[]>>;
  main: Array<() => ModelEvent[]>;
}): ModelPort {
  let mainIndex = 0;
  return {
    async *stream(req: ModelRequest) {
      const users = req.messages.filter((message) => message.role === "user");
      const last = users[users.length - 1];
      const text = typeof last?.content === "string" ? last.content : "";
      const child = opts.children[text];
      if (child !== undefined) {
        yield* child;
        return;
      }
      const next = opts.main[mainIndex];
      mainIndex++;
      if (next === undefined) throw new Error(`no main script for call ${mainIndex - 1}`);
      yield* next();
    },
  };
}

function parentEvents(bySession: Map<string, TranscriptEventInput[]>, id = "parent-1") {
  return bySession.get(id) ?? [];
}

function dataOf(event: TranscriptEventInput | undefined): Record<string, unknown> {
  return (event?.data ?? {}) as Record<string, unknown>;
}

describe("subagent dispatch identity", () => {
  it("stamps one taskId on started, finished, and the tool result", async () => {
    const { store, bySession } = fakeChatStore();
    const agent = createAgent({
      modelPort: routedPort({
        children: { "child work": textScript("child done") },
        main: [
          () => [
            toolUseStart("call-1", "task"),
            toolUseDelta("call-1", JSON.stringify({ message: "child work" })),
            modelDone("tool_use"),
          ],
          () => textScript("parent done"),
        ],
      }),
      chatStore: store,
      chatSessionId: "parent-1",
      chatMeta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
      enableTaskTool: true,
    });

    await agent.run("go");

    const events = parentEvents(bySession);
    const started = events.find((event) => event.type === "subagent_started");
    const finished = events.find((event) => event.type === "subagent_finished");
    const result = events.find((event) => event.type === "tool_result" && dataOf(event)["name"] === "task");
    expect(dataOf(started)["taskId"]).toEqual(expect.any(String));
    expect(dataOf(finished)["taskId"]).toBe(dataOf(started)["taskId"]);
    expect((dataOf(result)["displayMetadata"] as Record<string, unknown>)["taskId"])
      .toBe(dataOf(started)["taskId"]);
  });

  it("stamps the background taskId before the child starts", async () => {
    const { store, bySession } = fakeChatStore();
    const agent = createAgent({
      modelPort: routedPort({
        children: { "background work": textScript("child done") },
        main: [
          () => [
            toolUseStart("call-1", "task"),
            toolUseDelta("call-1", JSON.stringify({
              message: "background work",
              run_in_background: true,
            })),
            modelDone("tool_use"),
          ],
          () => textScript("parent done"),
        ],
      }),
      chatStore: store,
      chatSessionId: "parent-1",
      chatMeta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
      enableTaskTool: true,
    });

    await agent.run("go");
    await vi.waitFor(() => {
      expect(parentEvents(bySession).some((event) => event.type === "subagent_finished")).toBe(true);
    });

    const events = parentEvents(bySession);
    const started = events.find((event) => event.type === "subagent_started");
    const finished = events.find((event) => event.type === "subagent_finished");
    const result = events.find((event) => event.type === "tool_result" && dataOf(event)["name"] === "task");
    expect(dataOf(started)["taskId"]).toEqual(expect.any(String));
    expect(dataOf(finished)["taskId"]).toBe(dataOf(started)["taskId"]);
    expect((dataOf(result)["displayMetadata"] as Record<string, unknown>)["taskId"])
      .toBe(dataOf(started)["taskId"]);
  });

  it("gives parallel dispatches distinct taskIds that pair with their children", async () => {
    const { store, bySession } = fakeChatStore();
    const agent = createAgent({
      modelPort: routedPort({
        children: {
          "child A": textScript("A done"),
          "child B": textScript("B done"),
        },
        main: [
          () => twice(
            JSON.stringify({ message: "child A" }),
            JSON.stringify({ message: "child B" }),
          ),
          () => textScript("parent done"),
        ],
      }),
      chatStore: store,
      chatSessionId: "parent-1",
      chatMeta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
      enableTaskTool: true,
    });

    await agent.run("go");
    await vi.waitFor(() => {
      expect(parentEvents(bySession).filter((event) => event.type === "subagent_finished").length)
        .toBeGreaterThanOrEqual(2);
    });

    const events = parentEvents(bySession);
    const started = events.filter((event) => event.type === "subagent_started");
    const finished = events.filter((event) => event.type === "subagent_finished");
    const results = events.filter((event) => event.type === "tool_result" && dataOf(event)["name"] === "task");
    expect(new Set(started.map((event) => dataOf(event)["taskId"])).size).toBe(2);
    for (const event of finished) {
      expect(started.map((start) => dataOf(start)["taskId"])).toContain(dataOf(event)["taskId"]);
    }
    expect(results.map((event) =>
      (dataOf(event)["displayMetadata"] as Record<string, unknown>)["taskId"],
    ).sort()).toEqual(started.map((event) => dataOf(event)["taskId"]).sort());
  });
});
