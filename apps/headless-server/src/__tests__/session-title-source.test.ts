/**
 * Title provenance: which write wins when the derived (heuristic) title, the
 * model's title, and a user's manual rename all target the same session.
 *
 * These cases are the server-side half of "a manual rename is never
 * overwritten" — the client used to enforce it by never patching a non-empty
 * title, which no other client can be trusted to honour.
 */

import { afterEach, describe, expect, it } from "vitest";
import { startTestServer, type FrameEventPayload, type TestServer } from "./helpers.js";

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function boot(): Promise<TestServer> {
  const server = await startTestServer();
  servers.push(server);
  return server;
}

function authHeaders(server: TestServer): Record<string, string> {
  return {
    authorization: `Bearer ${server.token}`,
    "content-type": "application/json",
  };
}

/** Runs one turn so the session has a durable transcript to patch. */
async function runFirstTurn(server: TestServer): Promise<void> {
  await server.openEvents();
  const response = await fetch(`${server.url}/messages`, {
    method: "POST",
    headers: authHeaders(server),
    body: JSON.stringify({
      sessionId: server.sessionId,
      message: "hello",
      ...server.turnConfig,
    }),
  });
  expect(response.status).toBe(202);
  await server.captureMessages();
}

function rename(
  server: TestServer,
  body: Record<string, unknown>,
  sessionId: string = server.sessionId,
): Promise<Response> {
  return fetch(`${server.url}/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: authHeaders(server),
    body: JSON.stringify(body),
  });
}

/** The last persisted `session_meta` for the harness session, as raw data. */
async function persistedMeta(server: TestServer): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${server.url}/sessions/${encodeURIComponent(server.sessionId)}/events`,
    { headers: authHeaders(server) },
  );
  const body = (await response.json()) as {
    events: Array<{ type: string; data: Record<string, unknown> }>;
  };
  const metas = body.events.filter((event) => event.type === "session_meta");
  return metas.at(-1)?.data ?? {};
}

/** Polls the live channel until `predicate` matches, or throws on timeout. */
async function waitForEvent(
  server: TestServer,
  predicate: (event: FrameEventPayload) => boolean,
): Promise<FrameEventPayload> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const found = server.events().find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for a matching event frame");
}

describe("session title provenance", () => {
  it("stores a user title with its source", async () => {
    const server = await boot();
    await runFirstTurn(server);

    const response = await rename(server, { title: "手写标题", source: "user" });
    expect(response.status).toBe(204);

    const meta = await persistedMeta(server);
    expect(meta["title"]).toBe("手写标题");
    expect(meta["titleSource"]).toBe("user");
  });

  it("refuses a heuristic write over a model title", async () => {
    const server = await boot();
    await runFirstTurn(server);
    expect((await rename(server, { title: "模型标题", source: "model" })).status).toBe(204);

    const response = await rename(server, {
      title: "截断出来的标题",
      source: "heuristic",
    });
    expect(response.status).toBe(409);

    const meta = await persistedMeta(server);
    expect(meta["title"]).toBe("模型标题");
    expect(meta["titleSource"]).toBe("model");
  });

  it("refuses a model write over a user title", async () => {
    const server = await boot();
    await runFirstTurn(server);
    expect((await rename(server, { title: "我起的名字", source: "user" })).status).toBe(204);

    const response = await rename(server, { title: "生成的标题", source: "model" });
    expect(response.status).toBe(409);

    const meta = await persistedMeta(server);
    expect(meta["title"]).toBe("我起的名字");
    expect(meta["titleSource"]).toBe("user");
  });

  it("lets a model title replace a heuristic one", async () => {
    const server = await boot();
    await runFirstTurn(server);
    expect((await rename(server, { title: "首条消息…", source: "heuristic" })).status).toBe(204);

    const response = await rename(server, { title: "生成的标题", source: "model" });
    expect(response.status).toBe(204);

    const meta = await persistedMeta(server);
    expect(meta["title"]).toBe("生成的标题");
    expect(meta["titleSource"]).toBe("model");
  });

  it("defaults a source-less rename to user", async () => {
    const server = await boot();
    await runFirstTurn(server);

    const response = await rename(server, { title: "客户端旧写法" });
    expect(response.status).toBe(204);

    const meta = await persistedMeta(server);
    expect(meta["titleSource"]).toBe("user");
  });

  it("rejects an unknown source", async () => {
    const server = await boot();
    await runFirstTurn(server);

    const response = await rename(server, { title: "x", source: "plausible" });
    expect(response.status).toBe(400);
  });

  it("pushes the new title onto the session's live channel", async () => {
    const server = await boot();
    await runFirstTurn(server);

    const response = await rename(server, { title: "实时标题", source: "user" });
    expect(response.status).toBe(204);

    const frame = await waitForEvent(
      server,
      (event) => event.type === "session_meta" && event.data["title"] === "实时标题",
    );
    expect(frame.data["titleSource"]).toBe("user");
  });
});
