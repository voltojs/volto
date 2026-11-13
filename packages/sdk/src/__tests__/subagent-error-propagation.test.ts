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

describe("subagent error propagation", () => {
  it("marks a child turn that ended in error as a failed tool result", async () => {
    const { store, bySession } = fakeChatStore();
    let mainIndex = 0;
    const port: ModelPort = {
      async *stream(req: ModelRequest) {
        const users = req.messages.filter((message) => message.role === "user");
        const last = users[users.length - 1];
        const text = typeof last?.content === "string" ? last.content : "";
        if (text === "child work") throw new Error("child model exploded");
        const scripts: ModelEvent[][] = [
          [
            toolUseStart("c1", "task"),
            toolUseDelta("c1", JSON.stringify({ message: "child work" })),
            modelDone("tool_use"),
          ],
          textScript("parent done"),
        ];
        const next = scripts[mainIndex];
        mainIndex++;
        if (next === undefined) throw new Error(`no main script for call ${mainIndex - 1}`);
        yield* next;
      },
    };
    const agent = createAgent({
      modelPort: port,
      chatStore: store,
      chatSessionId: "parent-1",
      chatMeta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
      enableTaskTool: true,
    });

    await agent.run("go");

    const parent = bySession.get("parent-1") ?? [];
    const result = parent.find(
      (event) => event.type === "tool_result"
        && (event.data as Record<string, unknown>)["name"] === "task",
    );
    const finished = parent.find((event) => event.type === "subagent_finished");
    expect((result?.data as Record<string, unknown> | undefined)?.["isError"]).toBe(true);
    expect(String((result?.data as Record<string, unknown> | undefined)?.["content"]))
      .toContain("child model exploded");
    expect((finished?.data as Record<string, unknown> | undefined)?.["isError"]).toBe(true);
  });
});
