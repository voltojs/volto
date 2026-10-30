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

  it("collapses newlines and runs of whitespace", () => {
    expect(sanitizeGeneratedTitle("重构\n\n  标题")).toBe("重构 标题");
  });

  it("drops trailing sentence punctuation", () => {
    expect(sanitizeGeneratedTitle("重构会话标题。")).toBe("重构会话标题");
    expect(sanitizeGeneratedTitle("Fix the parser.")).toBe("Fix the parser");
  });

  it("caps at 200 codepoints", () => {
    expect(Array.from(sanitizeGeneratedTitle("长".repeat(260)) ?? "")).toHaveLength(200);
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
    const user = requests[0]!.messages.find((message) => message.role === "user");
    expect(user?.content).toBe("帮我重构会话标题");
  });

  it("treats a model error event as no title", async () => {
    expect(await generateTitle(fakePort([], [], "error-event"), "small", "hi")).toBeNull();
  });

  it("treats a thrown provider failure as no title", async () => {
    expect(await generateTitle(fakePort([], [], "throw"), "small", "hi")).toBeNull();
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
    const { server } = await bootWithTitleModel();
    await runTurn(server, "第一条消息");
    await eventually(async () => (await titleOf(server)) === "模型起的标题", "the model title");

    await runTurn(server, "第二条消息");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(await titleOf(server)).toBe("模型起的标题");
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
