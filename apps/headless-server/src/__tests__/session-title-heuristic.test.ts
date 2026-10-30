/**
 * The heuristic title: a session is named from its first user message as soon
 * as the first turn starts, before the model has produced a token, and that
 * name never changes on later turns.
 */

import { afterEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./helpers.js";

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

/** Runs one turn on the harness session, replacing the collected frames. */
async function runTurn(server: TestServer, message: string): Promise<void> {
  await server.openEvents();
  const response = await fetch(`${server.url}/messages`, {
    method: "POST",
    headers: authHeaders(server),
    body: JSON.stringify({
      sessionId: server.sessionId,
      message,
      ...server.turnConfig,
    }),
  });
  expect(response.status).toBe(202);
  await server.captureMessages();
}

interface PersistedMeta extends Record<string, unknown> {
  title?: string;
  titleSource?: string;
}

/** Every `session_meta` event in the durable log, in order. */
async function sessionMetaEvents(server: TestServer): Promise<PersistedMeta[]> {
  const response = await fetch(
    `${server.url}/sessions/${encodeURIComponent(server.sessionId)}/events`,
    { headers: authHeaders(server) },
  );
  const body = (await response.json()) as {
    events: Array<{ type: string; data: PersistedMeta }>;
  };
  return body.events.filter((event) => event.type === "session_meta").map((event) => event.data);
}

/**
 * The title the session currently carries, as the list endpoint reports it —
 * metas merge field-by-field, so the title is not necessarily on the newest
 * `session_meta` (the turn's own header arrives after the derived title).
 */
async function storedTitle(server: TestServer): Promise<string> {
  const response = await fetch(`${server.url}/sessions`, {
    headers: authHeaders(server),
  });
  const body = (await response.json()) as {
    sessions: Array<{ id: string; title: string }>;
  };
  return body.sessions.find((session) => session.id === server.sessionId)?.title ?? "";
}

describe("heuristic session title", () => {
  it("names a session from its first message, whitespace collapsed", async () => {
    const server = await boot();
    await runTurn(server, "重构  会话标题\n并补测试");

    expect(await storedTitle(server)).toBe("重构 会话标题 并补测试");
    // Provenance is what stops a later write from burying it.
    expect((await sessionMetaEvents(server)).some((m) => m.titleSource === "heuristic")).toBe(true);
  });

  it("caps a long first message at 200 codepoints plus an ellipsis", async () => {
    const server = await boot();
    await runTurn(server, "长".repeat(260));

    const title = await storedTitle(server);
    expect(title.endsWith("…")).toBe(true);
    expect(Array.from(title)).toHaveLength(201);
  });

  it("does not retitle on a later turn", async () => {
    const server = await boot();
    await runTurn(server, "第一条消息");
    const afterFirst = await sessionMetaEvents(server);

    await runTurn(server, "第二条消息，完全不同的内容");
    const afterSecond = await sessionMetaEvents(server);

    expect(afterSecond).toHaveLength(afterFirst.length);
    expect(await storedTitle(server)).toBe("第一条消息");
  });

  it("leaves a title the user already set alone", async () => {
    const server = await boot();
    await runTurn(server, "第一条消息");

    const patch = await fetch(`${server.url}/sessions/${encodeURIComponent(server.sessionId)}`, {
      method: "PATCH",
      headers: authHeaders(server),
      body: JSON.stringify({ title: "我起的名字", source: "user" }),
    });
    expect(patch.status).toBe(204);
    const afterRename = await sessionMetaEvents(server);

    await runTurn(server, "第二条消息");
    const afterSecond = await sessionMetaEvents(server);

    expect(afterSecond).toHaveLength(afterRename.length);
    expect(await storedTitle(server)).toBe("我起的名字");
  });
});
