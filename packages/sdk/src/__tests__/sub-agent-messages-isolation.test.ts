import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import { toolCallScript, textScript } from "@volto/core";
import type {
  ModelPort,
  ModelEvent,
  ModelRequest,
  Message,
} from "@volto/core";

/**
 * Spy port that records each call's `messages`, so we can prove the sub-agent
 * Runner starts from an empty conversation rather than inheriting the
 * parent's history.
 */
function createMessagesSpy(script: ModelEvent[][]): ModelPort & {
  calls: Array<{ messages: Message[] }>;
} {
  const calls: Array<{ messages: Message[] }> = [];
  let i = 0;
  return {
    calls,
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      calls.push({ messages: req.messages });
      const events = script[i++];
      if (!events) throw new Error(`spy: no script for call ${i - 1}`);
      for (const ev of events) yield ev;
    },
  };
}

describe("task sub-agent — messages isolation", () => {
  it("sub-agent's first model call sees only its own user message, not the parent history", async () => {
    const spy = createMessagesSpy([
      // call 1 — main agent: emit task tool_use
      toolCallScript("main-1", "task", JSON.stringify({ message: "research" })),
      // call 2 — sub-agent: text reply
      textScript("sub finished"),
      // call 3 — main agent: final summary
      textScript("done"),
    ]);

    const agent = createAgent({
      modelPort: spy,
      enableTaskTool: true,
    });

    await agent.run("Parent's question with sensitive context");

    expect(spy.calls).toHaveLength(3);

    // Main turn 1 — contains the parent user message.
    const main1 = spy.calls[0]!.messages;
    const main1Roles = main1.map((m) => m.role);
    expect(main1Roles).toContain("user");
    const main1Text = main1
      .map((m) =>
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .map((c) => (c.type === "text" ? c.text : ""))
                .join("")
            : "",
      )
      .join("|");
    expect(main1Text).toContain("Parent's question");

    // Sub-agent — its first call MUST see exactly one user message that is
    // the `task` tool's `message` argument, with NO trace of the parent
    // conversation.
    const sub1 = spy.calls[1]!.messages;
    expect(sub1).toHaveLength(1);
    expect(sub1[0]!.role).toBe("user");
    const sub1Text =
      typeof sub1[0]!.content === "string"
        ? sub1[0]!.content
        : Array.isArray(sub1[0]!.content)
          ? sub1[0]!.content
              .map((c) => (c.type === "text" ? c.text : ""))
              .join("")
          : "";
    expect(sub1Text).toBe("research");
    expect(sub1Text).not.toContain("Parent");

    // Main turn 2 — back to main, must include the task's tool_result.
    const main2 = spy.calls[2]!.messages;
    const main2HasToolResult = main2.some((m) => m.role === "tool");
    expect(main2HasToolResult).toBe(true);
    const main2Text = main2
      .map((m) =>
        Array.isArray(m.content)
          ? m.content
              .map((c) => (c.type === "tool_result" ? c.content : c.type === "text" ? c.text : ""))
              .join("")
          : typeof m.content === "string"
            ? m.content
            : "",
      )
      .join("|");
    expect(main2Text).toContain("sub finished");
  });

  it("sub-agent events are tagged with agentDepth so host can demux", async () => {
    const spy = createMessagesSpy([
      toolCallScript("c1", "task", JSON.stringify({ message: "go" })),
      textScript("sub speaks"),
      textScript("main wraps up"),
    ]);

    const received: Array<{ type: string; depth: number | undefined }> = [];
    const agent = createAgent({
      modelPort: spy,
      enableTaskTool: true,
      eventSink: {
        emit(ev) {
          received.push({
            type: ev.type,
            depth:
              typeof ev.data["agentDepth"] === "number"
                ? (ev.data["agentDepth"] as number)
                : undefined,
          });
        },
      },
    });

    await agent.run("hi");

    // Sub-agent text_delta must carry agentDepth >= 1; main agent text_delta
    // must not carry that tag (undefined).
    const subDeltas = received.filter(
      (e) => e.type === "text_delta" && (e.depth ?? 0) >= 1,
    );
    const mainDeltas = received.filter(
      (e) => e.type === "text_delta" && (e.depth ?? 0) === 0,
    );
    expect(subDeltas.length).toBeGreaterThanOrEqual(1);
    expect(mainDeltas.length).toBeGreaterThanOrEqual(1);
  });
});
