import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeSection, resolveWebSearch } from "../config/web-search.js";
import { startRouteTestServer } from "./helpers.js";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const authJson = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

const defaults = normalizeSection(undefined).config;

const deepSeekProvider = {
  id: "deepseek",
  piProvider: "deepseek",
  baseURL: null,
  apiKey: "sk-deep",
};

describe("resolveWebSearch", () => {
  it("auto reuses a DeepSeek channel's key", () => {
    const { options } = resolveWebSearch(defaults, { provider: deepSeekProvider });
    expect(options).toMatchObject({ source: "deepseek", sourceId: "deepseek", apiKey: "sk-deep" });
  });

  it("auto falls back to none for a non-DeepSeek channel", () => {
    const { options } = resolveWebSearch(defaults, {
      provider: { id: "oa", piProvider: "openai", baseURL: null, apiKey: "sk" },
    });
    expect(options).toEqual({ source: "none" });
  });

  it("off never wires the tool", () => {
    const config = { ...defaults, source: "off" };
    expect(resolveWebSearch(config, { provider: deepSeekProvider }).options).toEqual({ source: "off" });
  });

  it("uses the reused channel for an explicit deepseek source", () => {
    const config = {
      ...defaults,
      source: "deepseek",
      deepseek: { ...defaults.deepseek, sourceProviderId: "deepseek" },
    };
    const { options } = resolveWebSearch(config, {
      reused: { id: "deepseek", piProvider: "deepseek", baseURL: null, apiKey: "sk-deep" },
    });
    expect(options).toMatchObject({ source: "deepseek", apiKey: "sk-deep" });
  });

  it("reuses the selected channel's key even when the session runs on another channel", () => {
    const config = {
      ...defaults,
      source: "deepseek",
      deepseek: { ...defaults.deepseek, sourceProviderId: "ds-a" },
    };
    const { options, reason } = resolveWebSearch(config, {
      provider: { id: "ds-b", piProvider: "deepseek", baseURL: null, apiKey: "sk-b" },
      reused: { id: "ds-a", piProvider: "deepseek", baseURL: "https://api.deepseek.com", apiKey: "sk-a" },
    });
    expect(options).toMatchObject({
      source: "deepseek",
      apiKey: "sk-a",
      baseUrl: "https://api.deepseek.com",
    });
    expect(reason).toBe("reuse-channel");
  });

  it("falls back to the slot key when the reused channel lost its key", () => {
    const config = {
      ...defaults,
      source: "deepseek",
      deepseek: { ...defaults.deepseek, sourceProviderId: "ds-a" },
    };
    const { options, warnings } = resolveWebSearch(config, {
      reused: { id: "ds-a", piProvider: "deepseek", baseURL: null, apiKey: null },
    });
    expect(options).toEqual({ source: "none" });
    expect(warnings.join(" ")).toContain("ds-a");
  });

  it("uses the builtin slot key when no channel is reused", () => {
    const config = { ...defaults, source: "glm" };
    const { options } = resolveWebSearch(config, { keys: { glm: "sk-glm" } });
    expect(options).toMatchObject({ source: "glm", apiKey: "sk-glm" });
  });

  it("wires a custom endpoint source by id", () => {
    const spec = {
      method: "POST" as const,
      url: "https://s.example.com/search",
      bodyTemplate: '{"q":"{{query}}"}',
      paths: { list: "items", title: "title", url: "url" },
    };
    const config = {
      ...defaults,
      source: "mine",
      custom: [{ id: "mine", name: "Mine", apiKeyEnc: "enc", endpoint: spec }],
    };
    const { options } = resolveWebSearch(config, { keys: { custom: { mine: "sk-mine" } } });
    expect(options).toEqual({
      source: "endpoint",
      sourceId: "mine",
      label: "Mine",
      apiKey: "sk-mine",
      endpoint: spec,
    });
  });

  it("degrades to none with a warning when the custom id is gone", () => {
    const { options, warnings } = resolveWebSearch({ ...defaults, source: "gone" }, {});
    expect(options).toEqual({ source: "none" });
    expect(warnings.join(" ")).toContain("gone");
  });

  it("degrades to none with a warning when the reused channel lost its key", () => {
    const config = {
      ...defaults,
      source: "deepseek",
      deepseek: { ...defaults.deepseek, sourceProviderId: "deepseek" },
    };
    const { options, warnings } = resolveWebSearch(config, {
      provider: { ...deepSeekProvider, apiKey: null },
    });
    expect(options).toEqual({ source: "none" });
    expect(warnings.join(" ")).toContain("deepseek");
  });
});

describe("/config/web-search routes", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "web-search-route-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns the settings view without plaintext keys", async () => {
    const { url, token, close } = await startRouteTestServer();
    try {
      const res = await fetch(`${url}/config/web-search`, { headers: auth(token) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        source: string;
        resolved: { sourceId: string };
        custom: unknown[];
      };
      expect(body.source).toBe("auto");
      expect(body.resolved.sourceId).toBeDefined();
      expect(body.custom).toEqual([]);
      expect(JSON.stringify(body)).not.toContain("sk-");
    } finally {
      await close();
    }
  });

  it("persists a source and a custom entry through HTTP", async () => {
    const { url, token, close } = await startRouteTestServer();
    try {
      const put = await fetch(`${url}/config/web-search`, {
        method: "PUT",
        headers: authJson(token),
        body: JSON.stringify({ source: "glm", glm: { apiKey: "sk-1234567890" } }),
      });
      expect(put.status).toBe(200);
      const view = (await put.json()) as { source: string; builtins: { glm: { apiKeyMasked: string } } };
      expect(view.source).toBe("glm");
      expect(view.builtins.glm.apiKeyMasked).toContain("7890");

      const created = await fetch(`${url}/config/web-search/custom`, {
        method: "POST",
        headers: authJson(token),
        body: JSON.stringify({
          name: "Mine",
          endpoint: {
            method: "GET",
            url: "https://s.example.com/search?q={{query}}",
            paths: { list: "items", title: "title", url: "url" },
          },
        }),
      });
      expect(created.status).toBe(200);
      const customView = (await created.json()) as { custom: Array<{ id: string }> };
      const id = customView.custom[0]!.id;
      expect(id).toBe("mine");

      const removed = await fetch(`${url}/config/web-search/custom/${id}`, {
        method: "DELETE",
        headers: auth(token),
      });
      expect(removed.status).toBe(200);
      expect(((await removed.json()) as { custom: unknown[] }).custom).toEqual([]);
    } finally {
      await close();
    }
  });

  it("rejects a bad source with 400", async () => {
    const { url, token, close } = await startRouteTestServer();
    try {
      const res = await fetch(`${url}/config/web-search`, {
        method: "PUT",
        headers: authJson(token),
        body: JSON.stringify({ source: "nope" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it("answers a test search with guidance when nothing is configured", async () => {
    const { url, token, close } = await startRouteTestServer();
    try {
      const res = await fetch(`${url}/config/web-search/test`, {
        method: "POST",
        headers: authJson(token),
        body: JSON.stringify({ query: "volto" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { resolved: { sourceId: string }; error?: string };
      expect(body.resolved.sourceId).toBe("none");
      expect(body.error).toBeDefined();
    } finally {
      await close();
    }
  });
});
