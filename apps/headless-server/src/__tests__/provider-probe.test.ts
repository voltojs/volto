import { describe, it, expect } from "vitest";
import { startTestServer } from "./helpers.js";

const auth = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

describe("POST /providers/:id/probe", () => {
  it("reports the resolved protocol, auth and cache capability", async () => {
    const server = await startTestServer();
    try {
      const created = await fetch(`${server.url}/providers`, {
        method: "POST",
        headers: auth(server.token),
        body: JSON.stringify({
          kind: "custom",
          name: "Probe route",
          baseURL: "https://example.invalid/v1",
          apiKey: "sk-probe",
          protocol: "anthropic-messages",
          models: [{ name: "Probe model", code: "probe-model" }],
        }),
      });
      const provider = (await created.json()) as {
        id: string;
        models: Array<{ id: string }>;
      };
      const response = await fetch(`${server.url}/providers/${provider.id}/probe`, {
        method: "POST",
        headers: auth(server.token),
        body: JSON.stringify({ modelId: provider.models[0]!.id }),
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        ok: boolean;
        protocol?: string;
        checks: Record<string, boolean>;
      };
      expect(result).toMatchObject({
        ok: true,
        protocol: "anthropic-messages",
        checks: { model: true, auth: true, protocol: true, usage: true, cache: true },
      });
    } finally {
      await server.close();
    }
  });

  it("accepts a protocol override and rejects an unknown protocol", async () => {
    const server = await startTestServer();
    try {
      const created = await fetch(`${server.url}/providers`, {
        method: "POST",
        headers: auth(server.token),
        body: JSON.stringify({
          kind: "custom",
          name: "Probe route",
          baseURL: "https://example.invalid/v1",
          apiKey: "sk-probe",
          models: [{ name: "Probe model", code: "probe-model" }],
        }),
      });
      const provider = (await created.json()) as {
        id: string;
        models: Array<{ id: string }>;
      };
      const overridden = await fetch(`${server.url}/providers/${provider.id}/probe`, {
        method: "POST",
        headers: auth(server.token),
        body: JSON.stringify({
          modelId: provider.models[0]!.id,
          protocol: "openai-responses",
        }),
      });
      expect((await overridden.json()) as { protocol?: string }).toMatchObject({
        protocol: "openai-responses",
      });

      const bad = await fetch(`${server.url}/providers/${provider.id}/probe`, {
        method: "POST",
        headers: auth(server.token),
        body: JSON.stringify({ protocol: "nope" }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
