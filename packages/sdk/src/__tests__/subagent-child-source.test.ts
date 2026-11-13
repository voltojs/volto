import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import { modelDone, textScript, toolUseDelta, toolUseStart } from "@voltojs/core";
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

function routedPort(opts: {
  childMessage: string;
  childScript: ModelEvent[];
  main: Array<() => ModelEvent[]>;
}): ModelPort {
  let mainIndex = 0;
  return {
    async *stream(req: ModelRequest) {
      const users = req.messages.filter((message) => message.role === "user");
      const last = users[users.length - 1];
      const text = typeof last?.content === "string" ? last.content : "";
      if (text === opts.childMessage) {
        yield* opts.childScript;
        return;
      }
      const next = opts.main[mainIndex];
      mainIndex++;
      if (next === undefined) throw new Error(`no main script for call ${mainIndex - 1}`);
      yield* next();
    },
  };
}

function dataOf(event: TranscriptEventInput | undefined): Record<string, unknown> {
  return (event?.data ?? {}) as Record<string, unknown>;
}

describe("subagent child task source", () => {
  it("names the parent dispatch on the child's first user message", async () => {
    const { store, bySession } = fakeChatStore();
    const agent = createAgent({
      modelPort: routedPort({
        childMessage: "child work",
        childScript: textScript("child done"),
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

    const parent = bySession.get("parent-1") ?? [];
    const started = parent.find((event) => event.type === "subagent_started");
    const childId = dataOf(started)["childSessionId"];
    expect(childId).toEqual(expect.any(String));
    const child = bySession.get(String(childId)) ?? [];
    const firstUser = child.find((event) => event.type === "user_message");
    expect(dataOf(firstUser)["source"]).toEqual({
      kind: "subagent-task",
      parentSessionId: "parent-1",
      taskId: dataOf(started)["taskId"],
      label: "task",
    });
  });
});
