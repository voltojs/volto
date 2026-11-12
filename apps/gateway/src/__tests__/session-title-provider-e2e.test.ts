/**
 * The title model through a REAL provider: preferences → provider registry →
 * a pi-ai ModelPort → one OpenAI-compatible HTTP call.
 *
 * The other title tests inject a fake port, which leaves this wiring (the
 * gateway's default `titleModelPortFactory`) unexercised. A local HTTP stub
 * stands in for the provider so the whole path runs for real.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { startTestServer, type TestServer } from "./helpers.js";

interface StubProvider {
  /** Base URL to store on the provider — `<stub>/v1`. */
  baseURL: string;
  /** Request lines the stub received, e.g. `POST /v1/chat/completions`. */
  calls: string[];
  close: () => void;
}

/**
 * An OpenAI-compatible endpoint that answers with `answer` once, or with HTTP
 * 401 when `unauthorized` is set (the "the user's key is broken" case).
 */
async function startStubProvider(
  options: { answer?: string[]; unauthorized?: boolean } = {},
): Promise<StubProvider> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      calls.push(`${req.method ?? ""} ${req.url ?? ""}`);
      if (options.unauthorized) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid api key" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({
          id: "1",
          object: "chat.completion.chunk",
          created: 0,
          model: "stub-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      for (const text of options.answer ?? []) res.write(chunk({ content: text }, null));
      res.write(chunk({}, "stop"));
      res.write(
        `data: ${JSON.stringify({
          id: "1",
          object: "chat.completion.chunk",
          created: 0,
          model: "stub-model",
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => server.close(),
  };
}

const servers: TestServer[] = [];
const stubs: StubProvider[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const stub of stubs.splice(0)) stub.close();
});

function authHeaders(server: TestServer): Record<string, string> {
  return {
    authorization: `Bearer ${server.token}`,
    "content-type": "application/json",
  };
}

/** Registers the stub as a custom provider and makes it the title model. */
async function configureTitleModel(server: TestServer, stub: StubProvider): Promise<void> {
  const provider = (await (
    await fetch(`${server.url}/providers`, {
      method: "POST",
      headers: authHeaders(server),
      body: JSON.stringify({
        name: "stub",
        baseURL: stub.baseURL,
        apiKey: "sk-test",
        models: [{ name: "Stub Model", code: "stub-model" }],
      }),
    })
  ).json()) as { id: string; models: Array<{ id: string }> };

  const put = await fetch(`${server.url}/preferences`, {
    method: "PUT",
    headers: authHeaders(server),
    body: JSON.stringify({
      titleProviderId: provider.id,
      titleModelId: provider.models[0]!.id,
    }),
  });
  expect(put.status).toBe(200);
}

async function boot(stub: StubProvider): Promise<TestServer> {
  const server = await startTestServer();
  servers.push(server);
  stubs.push(stub);
  await configureTitleModel(server, stub);
  return server;
}

async function runFirstTurn(server: TestServer, message: string): Promise<void> {
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

describe("title model through a real provider", () => {
  it("names the session with the model the user configured", async () => {
    const stub = await startStubProvider({ answer: ["重构", "会话标题"] });
    const server = await boot(stub);
    await runFirstTurn(server, "帮我重构会话标题，顺便补测试");

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await titleOf(server)) !== "重构会话标题") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(await titleOf(server)).toBe("重构会话标题");
    // The call really went out over HTTP to the configured provider.
    expect(stub.calls).toEqual(["POST /v1/chat/completions"]);

    const events = (await (
      await fetch(`${server.url}/sessions/${encodeURIComponent(server.sessionId)}/events`, {
        headers: authHeaders(server),
      })
    ).json()) as { events: Array<{ type: string; data: Record<string, unknown> }> };
    expect(events.events.some((event) => event.data["titleSource"] === "model")).toBe(true);
  });

  it("keeps the truncated title and stays quiet when the provider rejects the key", async () => {
    const stub = await startStubProvider({ unauthorized: true });
    const server = await boot(stub);
    await runFirstTurn(server, "帮我重构会话标题");

    // Give the (doomed) call time to fail before asserting.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(stub.calls).toHaveLength(1);
    expect(await titleOf(server)).toBe("帮我重构会话标题");
    // A failed title is not a conversation error: no `error` event appears.
    const events = (await (
      await fetch(`${server.url}/sessions/${encodeURIComponent(server.sessionId)}/events`, {
        headers: authHeaders(server),
      })
    ).json()) as { events: Array<{ type: string }> };
    expect(events.events.some((event) => event.type === "error")).toBe(false);
  });
});
