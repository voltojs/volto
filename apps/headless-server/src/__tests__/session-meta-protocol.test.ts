import { describe, it, expect } from "vitest";
import { createStore } from "@volto/store-jsonl";
import { startTestServer } from "./helpers.js";

const auth = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

describe("session protocol audit", () => {
  it("records the resolved protocol on session_meta", async () => {
    const server = await startTestServer();
    try {
      const created = await fetch(`${server.url}/providers`, {
        method: "POST",
        headers: auth(server.token),
        body: JSON.stringify({
          kind: "custom",
          name: "Anthropic route",
          baseURL: "https://example.invalid/v1",
          apiKey: "sk-test",
          protocol: "anthropic-messages",
          models: [{ name: "Route model", code: "route-model" }],
        }),
      });
      expect(created.status).toBe(201);
      const provider = (await created.json()) as {
        id: string;
        models: Array<{ id: string }>;
      };

      await server.openEvents(server.sessionId);
      const response = await fetch(`${server.url}/messages`, {
        method: "POST",
        headers: auth(server.token),
        body: JSON.stringify({
          sessionId: server.sessionId,
          message: "hello",
          projectId: server.turnConfig.projectId,
          providerId: provider.id,
          modelId: provider.models[0]!.id,
          permissionMode: "full",
        }),
      });
      expect(response.status).toBe(202);
      await server.captureMessages();

      const store = createStore({ directory: server.configDir });
      const record = await store.readSession(server.sessionId);
      expect((record?.meta as Record<string, unknown> | undefined)?.["protocol"])
        .toBe("anthropic-messages");

      const updated = await fetch(`${server.url}/providers/${provider.id}`, {
        method: "PUT",
        headers: auth(server.token),
        body: JSON.stringify({ protocol: "openai-completions" }),
      });
      expect(updated.status).toBe(200);
      const listed = (await (await fetch(`${server.url}/providers`, {
        headers: auth(server.token),
      })).json()) as Array<{ id: string; protocol?: string }>;
      expect(listed.find((p) => p.id === provider.id)?.protocol).toBe("openai-completions");
      // Let the first turn release its latch before starting the second.
      for (let i = 0; i < 100 && server.registry.isRunning(server.sessionId); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await server.openEvents(server.sessionId);
      const second = await fetch(`${server.url}/messages`, {
        method: "POST",
        headers: auth(server.token),
        body: JSON.stringify({
          sessionId: server.sessionId,
          message: "again",
          projectId: server.turnConfig.projectId,
          providerId: provider.id,
          modelId: provider.models[0]!.id,
          permissionMode: "full",
        }),
      });
      expect(second.status).toBe(202);
      await server.captureMessages();

      const after = await store.readSession(server.sessionId);
      expect((after?.meta as Record<string, unknown> | undefined)?.["protocol"])
        .toBe("openai-completions");
    } finally {
      await server.close();
    }
  });
});
