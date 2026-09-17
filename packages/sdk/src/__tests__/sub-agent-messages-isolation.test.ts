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
              .map((c) => {
                if (c.type === "tool_result") {
                  // tool_result content is a block array since Task 1.
                  return Array.isArray(c.content)
                    ? c.content.map((b) => (b.type === "text" ? b.text : "")).join("")
                    : "";
                }
                return c.type === "text" ? c.text : "";
              })
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

  it("sub-agent transcript events keep their envelope stamps (time) through the tagged sink", async () => {
    // 网关的 frame()/asTranscriptEvent 靠信封上的 time 截识别 transcript 事件；
    // tagEventSink 若重建信封丢掉 time，子代理的 transcript 事件会在网关被整类
    // 丢弃（deltas 因走 delta 分支幸存）——运行中的面板就只剩 delta 可渲染。
    const spy = createMessagesSpy([
      toolCallScript("c1", "task", JSON.stringify({ message: "go" })),
      textScript("sub speaks"),
      textScript("main wraps up"),
    ]);

    const received: Array<{ type: string; depth: number | undefined; time: unknown; turn: unknown; step: unknown }> = [];
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
            time: (ev as { time?: unknown }).time,
            turn: (ev as { turn?: unknown }).turn,
            step: (ev as { step?: unknown }).step,
          });
        },
      },
    });

    await agent.run("hi");

    // 子代理的 transcript 事件（非 delta——delta 是原始流增量，无戳）必须
    // 保留 runner 盖的 time 戳；turn/step 若源上有，也必须原样透传。
    const subTranscript = received.filter(
      (e) => e.type !== "text_delta" && (e.depth ?? 0) >= 1,
    );
    expect(subTranscript.length).toBeGreaterThanOrEqual(1);
    for (const e of subTranscript) {
      expect(typeof e.time).toBe("number");
    }
    const subModelCallStart = subTranscript.find((e) => e.type === "model_call_start");
    expect(subModelCallStart).toBeDefined();
    expect(subModelCallStart!.turn).toBeDefined();
    expect(subModelCallStart!.step).toBeDefined();
  });

  it("sub-agent events carry childSessionId so parallel dispatches are attributable", async () => {
    const spy = createMessagesSpy([
      toolCallScript("c1", "task", JSON.stringify({ message: "go" })),
      textScript("sub speaks"),
      textScript("main wraps up"),
    ]);

    const received: Array<{ type: string; depth: number | undefined; childId: unknown }> = [];
    const agent = createAgent({
      modelPort: spy,
      enableTaskTool: true,
      // 无 chatSessionId 时 childSessionId 退化为 undefined —— 用两个 agent 分别断言。
      chatSessionId: "sess-test",
      eventSink: {
        emit(ev) {
          received.push({
            type: ev.type,
            depth: typeof ev.data["agentDepth"] === "number" ? (ev.data["agentDepth"] as number) : undefined,
            childId: ev.data["childSessionId"],
          });
        },
      },
    });

    await agent.run("hi");

    const tagged = received.filter((e) => (e.depth ?? 0) >= 1);
    expect(tagged.length).toBeGreaterThanOrEqual(1);
    for (const e of tagged) {
      expect(String(e.childId)).toMatch(/^sess-test-sub-/);
    }
  });

  it("without chatSessionId, sub-agent events carry no childSessionId (degenerate path)", async () => {
    const spy = createMessagesSpy([
      toolCallScript("c1", "task", JSON.stringify({ message: "go" })),
      textScript("sub speaks"),
      textScript("main wraps up"),
    ]);

    const received: Array<{ type: string; depth: number | undefined; childId: unknown }> = [];
    const agent = createAgent({
      modelPort: spy,
      enableTaskTool: true,
      // 不传 chatSessionId：没有可归属的父会话，childSessionId 必须缺席。
      eventSink: {
        emit(ev) {
          received.push({
            type: ev.type,
            depth: typeof ev.data["agentDepth"] === "number" ? (ev.data["agentDepth"] as number) : undefined,
            childId: ev.data["childSessionId"],
          });
        },
      },
    });

    await agent.run("hi");

    const tagged = received.filter((e) => (e.depth ?? 0) >= 1);
    expect(tagged.length).toBeGreaterThanOrEqual(1);
    for (const e of tagged) {
      expect(e.childId).toBeUndefined();
    }
  });

  it("brackets ride the live event sink with the parent's turn stamp", async () => {
    const spy = createMessagesSpy([
      toolCallScript("c1", "task", JSON.stringify({ message: "go" })),
      textScript("sub speaks"),
      textScript("main wraps up"),
    ]);

    const received: Array<{ type: string; turn: unknown; childId: unknown; agentDepth: unknown }> = [];
    const agent = createAgent({
      modelPort: spy,
      enableTaskTool: true,
      chatSessionId: "sess-bracket",
      eventSink: {
        emit(ev) {
          received.push({
            type: ev.type,
            turn: (ev as { turn?: unknown }).turn,
            childId: ev.data["childSessionId"],
            agentDepth: ev.data["agentDepth"],
          });
        },
      },
    });

    await agent.run("hi");

    const started = received.filter((e) => e.type === "subagent_started");
    const finished = received.filter((e) => e.type === "subagent_finished");
    expect(started).toHaveLength(1);
    expect(finished).toHaveLength(1);
    // 父 turn 戳：无 turn 的 bracket 会在客户端投影里掉进幽灵 turn 0。
    expect(typeof started[0]!.turn).toBe("number");
    expect(typeof finished[0]!.turn).toBe("number");
    // 父级事件：绝不能带 agentDepth（否则会被客户端路由进子桶）。
    expect(started[0]!.agentDepth).toBeUndefined();
    expect(finished[0]!.agentDepth).toBeUndefined();
    // childSessionId 与持久化 bracket 一致（opaque，前缀断言）。
    expect(String(started[0]!.childId)).toMatch(/^sess-bracket-sub-/);
    expect(String(finished[0]!.childId)).toMatch(/^sess-bracket-sub-/);
  });
});
