/**
 * The model-written title: one cheap call after the first successful turn,
 * replacing the heuristic title only. Every failure keeps the heuristic one
 * and never surfaces an error in the conversation.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelPort, ModelRequest } from "@volto/core";
import {
  generateTitle,
  sanitizeGeneratedTitle,
  TITLE_TIMEOUT_MS,
} from "../session-title.js";
import { startTestServer, type TestServer } from "./helpers.js";

const servers: TestServer[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function authHeaders(server: TestServer): Record<string, string> {
  return {
    authorization: `Bearer ${server.token}`,
    "content-type": "application/json",
  };
}

/** A port that answers with `chunks` and ends, recording each request. */
function fakePort(
  chunks: string[],
  requests: ModelRequest[] = [],
  failWith?: "error-event" | "throw",
): ModelPort {
  return {
    async *stream(request) {
      requests.push(request);
      if (failWith === "throw") throw new Error("provider exploded");
      for (const text of chunks) yield { type: "text_delta", text };
      if (failWith === "error-event") {
        yield { type: "error", error: "model said no" };
        return;
      }
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

describe("sanitizeGeneratedTitle", () => {
  it("unwraps quotes, backticks and a code fence", () => {
    expect(sanitizeGeneratedTitle('"重构会话标题"')).toBe("重构会话标题");
    expect(sanitizeGeneratedTitle("`重构会话标题`")).toBe("重构会话标题");
    expect(sanitizeGeneratedTitle("```\n重构会话标题\n```")).toBe("重构会话标题");
  });

  it("collapses runs of whitespace within one line", () => {
    expect(sanitizeGeneratedTitle("重构   标题")).toBe("重构 标题");
  });

  it("drops trailing sentence punctuation", () => {
    expect(sanitizeGeneratedTitle("重构会话标题。")).toBe("重构会话标题");
    expect(sanitizeGeneratedTitle("Fix the parser.")).toBe("Fix the parser");
  });

  it("refuses output longer than a title", () => {
    // A reply, not a name: clipping it would fabricate a title from a
    // sentence the model never meant as one.
    expect(sanitizeGeneratedTitle("长".repeat(41))).toBeNull();
    expect(Array.from(sanitizeGeneratedTitle("长".repeat(40)) ?? "")).toHaveLength(40);
  });

  it("refuses a multi-line reply", () => {
    expect(sanitizeGeneratedTitle("好的，我来分析项目。\n\n## 结构\n\n- 入口")).toBeNull();
  });

  it("refuses tool-call and markdown traces", () => {
    expect(sanitizeGeneratedTitle("<tool_call><function=search_codebase>…")).toBeNull();
    expect(sanitizeGeneratedTitle("# 项目分析")).toBeNull();
    expect(sanitizeGeneratedTitle("重构 `会话标题")).toBeNull();
  });

  it("rejects output with no letters or digits", () => {
    expect(sanitizeGeneratedTitle("")).toBeNull();
    expect(sanitizeGeneratedTitle("   ")).toBeNull();
    expect(sanitizeGeneratedTitle('""')).toBeNull();
    expect(sanitizeGeneratedTitle("···")).toBeNull();
  });
});

describe("generateTitle", () => {
  it("joins the streamed deltas into a cleaned title", async () => {
    const requests: ModelRequest[] = [];
    const title = await generateTitle(fakePort(["重构  ", "会话标题"], requests), "small", "帮我重构会话标题");

    expect(title).toBe("重构 会话标题");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe("small");
    expect(requests[0]!.tools).toEqual([]);
  });

  it("sends the naming instruction inside the user message", async () => {
    // Models that ignore a bare system instruction answer the message
    // instead of naming it, so the instruction has to travel with the text.
    const requests: ModelRequest[] = [];
    await generateTitle(fakePort(["重构会话标题"], requests), "small", "帮我重构会话标题");

    const messages = requests[0]!.messages;
    expect(messages.some((message) => message.role === "system")).toBe(false);
    const user = messages.find((message) => message.role === "user");
    expect(user?.content).toContain("title only");
    expect(user?.content).toContain("<conversation>");
    expect(user?.content).toContain("帮我重构会话标题");
  });

  it("treats a max_tokens finish as no title", async () => {
    const port: ModelPort = {
      async *stream() {
        yield { type: "text_delta", text: "我来帮你分析项目结构" };
        yield { type: "done", stopReason: "max_tokens" };
      },
    };

    expect(await generateTitle(port, "small", "分析一下该项目")).toBeNull();
  });

  it("treats a model error event as no title", async () => {
    expect(await generateTitle(fakePort([], [], "error-event"), "small", "hi")).toBeNull();
  });

  it("treats a thrown provider failure as no title", async () => {
    expect(await generateTitle(fakePort([], [], "throw"), "small", "hi")).toBeNull();
  });

  it("ignores output a port keeps producing after the timeout", async () => {
    vi.useFakeTimers();
    // A port that never looks at its abort signal and answers late: the 15s
    // bound has to hold anyway, or a stalled provider could still rename a
    // session minutes later.
    const port: ModelPort = {
      async *stream() {
        await new Promise((resolve) => setTimeout(resolve, TITLE_TIMEOUT_MS + 1_000));
        yield { type: "text_delta", text: "迟到的标题" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };

    const pending = generateTitle(port, "small", "hi");
    await vi.advanceTimersByTimeAsync(TITLE_TIMEOUT_MS + 1_000);

    expect(await pending).toBeNull();
  });

  it("aborts the request on timeout and answers null", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const port: ModelPort = {
      async *stream(request) {
        signal = request.abortSignal;
        await new Promise((_resolve, reject) => {
          request.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
        yield { type: "done", stopReason: "end_turn" };
      },
    };

    const pending = generateTitle(port, "small", "hi");
    await vi.advanceTimersByTimeAsync(TITLE_TIMEOUT_MS);

    expect(await pending).toBeNull();
    expect(signal?.aborted).toBe(true);
  });
});

// ── Integration through the gateway ────────────────────────────────────

interface TitlePortCall {
  /** How many times the gateway asked for a title port. */
  count: number;
}

async function bootWithTitleModel(options: {
  answer?: string[];
  onStream?: (call: number) => Promise<void> | void;
} = {}): Promise<{ server: TestServer; calls: TitlePortCall }> {
  const calls: TitlePortCall = { count: 0 };
  const server = await startTestServer({
    titleModelPortFactory: async () => {
      calls.count += 1;
      let streamed = 0;
      const port: ModelPort = {
        async *stream() {
          streamed += 1;
          await options.onStream?.(streamed);
          for (const text of options.answer ?? ["模型起的标题"]) {
            yield { type: "text_delta", text };
          }
          yield { type: "done", stopReason: "end_turn" };
        },
      };
      return { modelPort: port, model: "title-model" };
    },
  });
  servers.push(server);
  return { server, calls };
}

async function runTurn(server: TestServer, message: string): Promise<void> {
  await server.openEvents();
  const response = await fetch(`${server.url}/messages`, {
    method: "POST",
    headers: authHeaders(server),
    body: JSON.stringify({ sessionId: server.sessionId, message, ...server.turnConfig }),
  });
  expect(response.status).toBe(202);
  await server.captureMessages();
}

async function titleOf(server: TestServer): Promise<string> {
  const response = await fetch(`${server.url}/sessions`, { headers: authHeaders(server) });
  const body = (await response.json()) as {
    sessions: Array<{ id: string; title: string }>;
  };
  return body.sessions.find((session) => session.id === server.sessionId)?.title ?? "";
}

/** Polls until `check` holds, for state written by a fire-and-forget task. */
async function eventually(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("title model through the gateway", () => {
  it("replaces the heuristic title with the model's answer", async () => {
    const { server } = await bootWithTitleModel({ answer: ["重构", "会话标题"] });
    await runTurn(server, "帮我重构会话标题，顺便补测试");

    await eventually(async () => (await titleOf(server)) === "重构会话标题", "the model title");

    const events = await fetch(
      `${server.url}/sessions/${encodeURIComponent(server.sessionId)}/events`,
      { headers: authHeaders(server) },
    );
    const body = (await events.json()) as {
      events: Array<{ type: string; data: Record<string, unknown> }>;
    };
    expect(
      body.events.some((event) => event.data["titleSource"] === "model"),
    ).toBe(true);
  });

  it("keeps the heuristic title when the model answers instead of naming", async () => {
    const { server } = await bootWithTitleModel({
      answer: [
        "好的，我来分析这个项目。首先看一下根目录和关键配置文件。",
        "目录里有几个关键文件：package.json、tsconfig.json、vite.config.ts。",
      ],
    });
    await runTurn(server, "分析一下该项目，介绍一下它是怎样工作的");

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await titleOf(server)).toBe("分析一下该项目，介绍一下它是怎样工作的");
    const events = (await (
      await fetch(`${server.url}/sessions/${encodeURIComponent(server.sessionId)}/events`, {
        headers: authHeaders(server),
      })
    ).json()) as { events: Array<{ type: string; data: Record<string, unknown> }> };
    expect(events.events.some((event) => event.data["titleSource"] === "model")).toBe(false);
  });

  it("starts naming before the first turn settles", async () => {
    // The title is decoration on the session, not a result of the answer: it
    // has to be requested as soon as the first message exists, so the header
    // is not left generic for the whole turn.
    let releaseMain: () => void = () => {};
    const mainGate = new Promise<void>((resolve) => {
      releaseMain = resolve;
    });
    const mainPort: ModelPort = {
      async *stream() {
        yield { type: "text_delta", text: "我会在标题之后结束" };
        await mainGate;
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    let markTitleStarted: () => void = () => {};
    const titleStarted = new Promise<void>((resolve) => {
      markTitleStarted = resolve;
    });
    const server = await startTestServer({
      modelPort: mainPort,
      titleModelPortFactory: async () => ({
        modelPort: {
          async *stream() {
            markTitleStarted();
            yield { type: "text_delta", text: "项目工作原理分析" };
            yield { type: "done", stopReason: "end_turn" };
          },
        },
        model: "title-model",
      }),
    });
    servers.push(server);

    await server.openEvents();
    const response = await fetch(`${server.url}/messages`, {
      method: "POST",
      headers: authHeaders(server),
      body: JSON.stringify({
        sessionId: server.sessionId,
        message: "分析一下该项目",
        ...server.turnConfig,
      }),
    });
    expect(response.status).toBe(202);

    const raced = await Promise.race([
      titleStarted.then(() => "started"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
    ]);
    releaseMain();
    await server.captureMessages();

    expect(raced).toBe("started");
    expect(await titleOf(server)).toBe("项目工作原理分析");
  });

  it("does not call a title model when one is not configured", async () => {
    // The default factory reads /preferences; nothing is configured here.
    const server = await startTestServer();
    servers.push(server);
    await runTurn(server, "第一条消息");
    // Give a (wrong) background generation a chance to land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(await titleOf(server)).toBe("第一条消息");
  });

  it("names a session once, not on every turn", async () => {
    const { server, calls } = await bootWithTitleModel();
    await runTurn(server, "第一条消息");
    await eventually(async () => (await titleOf(server)) === "模型起的标题", "the model title");

    await runTurn(server, "第二条消息");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(await titleOf(server)).toBe("模型起的标题");
    // The claim is "named once", not just "the title did not change": a second
    // call returning the same answer would look identical from the title.
    expect(calls.count).toBe(1);
  });

  it("writes nothing when the model repeats the heuristic title", async () => {
    const { server } = await bootWithTitleModel({ answer: ["第一条消息"] });
    await runTurn(server, "第一条消息");

    // Give a (wrong) write a chance to land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const events = (await (
      await fetch(`${server.url}/sessions/${encodeURIComponent(server.sessionId)}/events`, {
        headers: authHeaders(server),
      })
    ).json()) as { events: Array<{ type: string; data: Record<string, unknown> }> };
    expect(events.events.some((event) => event.data["titleSource"] === "model")).toBe(false);
  });

  it("gives up when the user renames while the title is being generated", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { server, calls } = await bootWithTitleModel({
      answer: ["迟到的模型标题"],
      onStream: () => gate,
    });

    await runTurn(server, "第一条消息");
    // The generation is now parked mid-stream; the user renames meanwhile.
    await eventually(async () => calls.count > 0, "the title call to start");
    const patch = await fetch(`${server.url}/sessions/${encodeURIComponent(server.sessionId)}`, {
      method: "PATCH",
      headers: authHeaders(server),
      body: JSON.stringify({ title: "我起的名字", source: "user" }),
    });
    expect(patch.status).toBe(204);

    release();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await titleOf(server)).toBe("我起的名字");
  });
});
