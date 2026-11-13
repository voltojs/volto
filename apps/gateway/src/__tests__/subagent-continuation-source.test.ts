import { describe, it, expect } from "vitest";
import { createStore } from "@voltojs/store-jsonl";
import { startTestServer } from "./helpers.js";

async function seedSubagentSession(opts: {
  configDir: string;
  sessionId: string;
  parentSessionId?: string;
}): Promise<void> {
  const store = createStore({ directory: opts.configDir });
  await store.appendEvents(opts.configDir, opts.sessionId, [
    {
      time: Date.now(),
      type: "session_meta",
      data: {
        projectId: null,
        providerId: null,
        modelId: null,
        permissionMode: null,
        ...(opts.parentSessionId !== undefined
          ? { parentSessionId: opts.parentSessionId }
          : {}),
        delegationDepth: 1,
        origin: "subagent",
      },
    },
  ]);
}

describe("host continuation provenance", () => {
  it("records a subagent follow-up as host-continuation", async () => {
    const server = await startTestServer();
    const childId = "subagent-child-1";
    try {
      await seedSubagentSession({
        configDir: server.configDir,
        sessionId: childId,
        parentSessionId: "parent-9",
      });
      await server.openEvents(childId);
      const res = await fetch(`${server.url}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: childId, message: "continue", ...server.turnConfig }),
      });
      expect(res.status).toBe(202);
      await server.captureMessages();

      const user = server.events().find((event) => event.type === "user_message");
      expect(user?.data["source"]).toEqual({
        kind: "host-continuation",
        parentSessionId: "parent-9",
      });
    } finally {
      await server.close();
    }
  });

  it("rejects a non-string message body instead of trusting its source", async () => {
    const server = await startTestServer();
    try {
      const res = await fetch(`${server.url}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: server.sessionId,
          message: {
            type: "user_message",
            content: "spoofed",
            source: { kind: "subagent-task", parentSessionId: "p", taskId: "t" },
          },
          ...server.turnConfig,
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("keeps a main session message free of a source", async () => {
    const server = await startTestServer();
    try {
      await server.openEvents(server.sessionId);
      const res = await fetch(`${server.url}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: server.sessionId, message: "hello", ...server.turnConfig }),
      });
      expect(res.status).toBe(202);
      await server.captureMessages();

      const user = server.events().find((event) => event.type === "user_message");
      expect(user).toBeDefined();
      expect("source" in (user!.data as Record<string, unknown>)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("omits parentSessionId when the subagent meta never named one", async () => {
    const server = await startTestServer();
    const childId = "subagent-child-2";
    try {
      await seedSubagentSession({ configDir: server.configDir, sessionId: childId });
      await server.openEvents(childId);
      const res = await fetch(`${server.url}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: childId, message: "continue", ...server.turnConfig }),
      });
      expect(res.status).toBe(202);
      await server.captureMessages();

      const user = server.events().find((event) => event.type === "user_message");
      expect(user?.data["source"]).toEqual({ kind: "host-continuation" });
    } finally {
      await server.close();
    }
  });
});
