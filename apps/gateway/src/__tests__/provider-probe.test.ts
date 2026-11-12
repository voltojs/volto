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
        cache?: string;
        checks: Record<string, boolean>;
      };
      expect(result).toMatchObject({
        live: false,
        ok: true,
        protocol: "anthropic-messages",
        cache: "explicit",
        checks: { model: true, auth: true, protocol: true },
      });
    } finally {
      await server.close();
    }
  });

  it("probes all three protocol routes on one provider", async () => {
    const server = await startTestServer();
    try {
      const protocols = [
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
      ] as const;
      const created = await fetch(`${server.url}/providers`, {
        method: "POST",
        headers: auth(server.token),
        body: JSON.stringify({
          kind: "custom",
          name: "Three protocol routes",
          baseURL: "https://example.invalid/v1",
          apiKey: "sk-three",
          models: protocols.map((protocol) => ({
            name: protocol,
            code: protocol,
            protocol,
          })),
        }),
      });
      const provider = (await created.json()) as {
        id: string;
        models: Array<{ id: string; code: string }>;
      };
      for (const protocol of protocols) {
        const model = provider.models.find((m) => m.code === protocol)!;
        const response = await fetch(`${server.url}/providers/${provider.id}/probe`, {
          method: "POST",
          headers: auth(server.token),
          body: JSON.stringify({ modelId: model.id }),
        });
        expect(await response.json()).toMatchObject({ ok: true, protocol });
      }
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
      expect((await overridden.json()) as { protocol?: string; live?: boolean }).toMatchObject({
        live: false,
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
