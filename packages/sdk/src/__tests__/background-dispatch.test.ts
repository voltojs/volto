import { describe, it, expect } from "vitest";
import { createBackgroundRegistry } from "../create-agent.js";

describe("background registry", () => {
  it("collects a finished task's result", async () => {
    const reg = createBackgroundRegistry();
    reg.register("t1", Promise.resolve("the answer"));
    await expect(reg.collect("t1")).resolves.toEqual({ text: "the answer" });
  });

  it("is idempotent: collecting twice returns the same result", async () => {
    const reg = createBackgroundRegistry();
    reg.register("t1", Promise.resolve("once"));
    const a = await reg.collect("t1");
    const b = await reg.collect("t1");
    expect(b).toEqual(a);
  });

  it("reports an unknown id as an error rather than hanging", async () => {
    const reg = createBackgroundRegistry();
    await expect(reg.collect("nope")).resolves.toEqual({ error: expect.stringContaining("nope") });
  });

  it("normalizes a rejected task into an error result", async () => {
    const reg = createBackgroundRegistry();
    reg.register("t1", Promise.reject(new Error("boom")));
    const out = await reg.collect("t1");
    expect(out).toEqual({ error: expect.stringContaining("boom") });
  });

  it("lists ids that have not been collected yet", async () => {
    const reg = createBackgroundRegistry();
    reg.register("t1", Promise.resolve("a"));
    reg.register("t2", Promise.resolve("b"));
    await reg.collect("t1");
    expect(reg.pending()).toEqual(["t2"]);
  });
});

// ──────────────────────────────────────────────
// End-to-end wiring: dispatch → registry → task_output
// ──────────────────────────────────────────────

import { createAgent } from "../create-agent.js";
import { toolCallScript, textScript } from "@volto/core";
import type { ModelPort, ModelRequest } from "@volto/core";

/**
 * Content-routed mock: the sub-agent's request carries its dispatch message
 * as the latest user message, the main agent's never does. Routing on
 * content (not call order) keeps the test deterministic while the detached
 * sub-agent's model call races the parent's next one.
 */
function contentRoutedPort(opts: {
  subMessage: string;
  subReply: string;
  mainCalls: Array<(req: ModelRequest) => ReturnType<typeof toolCallScript> | ReturnType<typeof textScript>>;
}): ModelPort {
  let mainIndex = 0;
  return {
    async *stream(req) {
      const users = req.messages.filter((m) => m.role === "user");
      const lastUser = users[users.length - 1];
      const lastUserText = typeof lastUser?.content === "string" ? lastUser.content : "";
      if (lastUserText === opts.subMessage) {
        yield* textScript(opts.subReply);
        return;
      }
      const step = opts.mainCalls[mainIndex];
      mainIndex++;
      if (!step) throw new Error(`no main script for call ${mainIndex - 1}`);
      yield* step(req);
    },
  } as ModelPort;
}

/** Extracts the task id the task tool embedded in its tool_result. */
function extractTaskId(req: ModelRequest): string {
  for (const m of req.messages) {
    if (m.role !== "tool" || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type !== "tool_result") continue;
      const match = /task_id="([^"]+)"/.exec(block.content);
      if (match?.[1]) return match[1];
    }
  }
  throw new Error("no task_id in request messages");
}

describe("background dispatch wiring", () => {
  it("returns a task id immediately; task_output collects it; repeat collect is idempotent (F-032/F-033/F-034)", async () => {
    const SUB_MSG = "Investigate the subsystem";
    const SUB_REPLY = "Sub-agent found the answer";
    let collectedTaskId = "";

    const modelPort = contentRoutedPort({
      subMessage: SUB_MSG,
      subReply: SUB_REPLY,
      mainCalls: [
        () => toolCallScript("m1", "task", JSON.stringify({ message: SUB_MSG, run_in_background: true })),
        (req) => {
          collectedTaskId = extractTaskId(req);
          return toolCallScript("m2", "task_output", JSON.stringify({ task_id: collectedTaskId }));
        },
        (req) => toolCallScript("m3", "task_output", JSON.stringify({ task_id: extractTaskId(req) })),
        () => textScript("All collected."),
      ],
    });

    const agent = createAgent({ modelPort, enableTaskTool: true });
    const state = await agent.run("Start a background investigation");

    expect(state.status).toBe("done");

    const toolMessages = state.messages.filter((m) => m.role === "tool");
    // m1: dispatch — task id present, result text NOT leaked into it
    const dispatchResult = toolMessages[0]!.content[0]!;
    expect(dispatchResult.isError).toBeFalsy();
    expect(dispatchResult.content).toContain("started in background");
    expect(dispatchResult.content).toContain(collectedTaskId);
    expect(dispatchResult.content).not.toContain(SUB_REPLY);

    // m2 + m3: both task_output calls return the sub-agent's result
    const outputResults = toolMessages.slice(1, 3).map((m) => m.content[0]!);
    expect(outputResults).toHaveLength(2);
    for (const r of outputResults) {
      expect(r.isError).toBeFalsy();
      expect(r.content).toContain(SUB_REPLY);
    }

    // The dispatch is recorded in serializable state as running
    expect(state.backgroundTasks).toEqual([
      expect.objectContaining({ id: collectedTaskId, status: "running" }),
    ]);

    const last = state.messages[state.messages.length - 1]!;
    expect(last.role).toBe("assistant");
  });

  it("surfaces an unknown task_id from task_output as an error result", async () => {
    const modelPort = contentRoutedPort({
      subMessage: "never dispatched",
      subReply: "unused",
      mainCalls: [
        () => toolCallScript("m1", "task_output", JSON.stringify({ task_id: "ghost-1" })),
        () => textScript("Acknowledged."),
      ],
    });

    const agent = createAgent({ modelPort, enableTaskTool: true });
    const state = await agent.run("Collect a task that does not exist");

    expect(state.status).toBe("done");
    const result = state.messages.find((m) => m.role === "tool")!.content[0]!;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("ghost-1");
  });
});
