import { describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { buildModels, describeModelInfo, type PiAiProviderConfig } from "../collection.js";

// A model literal with reasoning metadata, constructed by hand per the
// pinned `Model<TApi>` shape (api-notes.md item 7): `reasoning: true` plus
// `thinkingLevelMap` drives `getSupportedThinkingLevels()`.
const reasoningModel: Model<"openai-completions"> = {
  id: "reasoner-1",
  name: "Reasoner One",
  api: "openai-completions",
  provider: "acme",
  baseUrl: "https://acme.example/v1",
  reasoning: true,
  thinkingLevelMap: {
    off: null,
    low: "low",
    medium: "medium",
    high: "high",
  },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

function twoProviderConfigs(): PiAiProviderConfig[] {
  return [
    {
      id: "acme",
      baseURL: "https://acme.example/v1",
      apiKey: "acme-key",
      models: [{ code: "plain-model", contextWindow: 8192, maxOutputTokens: 2048 }],
    },
    {
      id: "other",
      baseURL: "https://other.example/v1",
      apiKey: "other-key",
      models: [{ code: "other-model" }],
    },
  ];
}

describe("buildModels", () => {
  it("resolves each configured provider's model via getModel(provider, code)", () => {
    const models = buildModels(twoProviderConfigs());

    const acmeModel = models.getModel("acme", "plain-model");
    expect(acmeModel).toBeDefined();
    expect(acmeModel?.provider).toBe("acme");

    const otherModel = models.getModel("other", "other-model");
    expect(otherModel).toBeDefined();
    expect(otherModel?.provider).toBe("other");
  });

  it("returns undefined for an unknown provider or unknown model", () => {
    const models = buildModels(twoProviderConfigs());

    expect(models.getModel("nope", "plain-model")).toBeUndefined();
    expect(models.getModel("acme", "nope")).toBeUndefined();
  });
});

describe("describeModelInfo", () => {
  it("omits `reasoning` entirely for a hand-declared model with no reasoning metadata", () => {
    const models = buildModels(twoProviderConfigs());

    const info = describeModelInfo(models, "acme", "plain-model");

    expect(info.model).toBe("plain-model");
    expect(info.contextWindow).toBe(8192);
    expect(info.reasoning).toBeUndefined();
  });

  it("publishes a non-empty efforts list, verbatim, for a reasoning-capable model", () => {
    const models = buildModels([]);
    // Inject a hand-built reasoning-capable model onto a manually registered
    // provider, since config-driven providers in this phase never carry
    // reasoning metadata (see task brief: no catalog path yet).
    models.setProvider({
      id: "acme",
      name: "acme",
      auth: { apiKey: { name: "test", resolve: async () => ({ auth: {} }) } },
      getModels: () => [reasoningModel],
      streamSimple: () => {
        throw new Error("not used in this test");
      },
      stream: () => {
        throw new Error("not used in this test");
      },
    });

    const info = describeModelInfo(models, "acme", "reasoner-1");

    expect(info.model).toBe("reasoner-1");
    expect(info.reasoning).toBeDefined();
    expect(info.reasoning?.efforts.length).toBeGreaterThan(0);

    const ids = info.reasoning?.efforts.map((e) => e.id) ?? [];
    // Effort ids are published verbatim from pi-ai's ModelThinkingLevel
    // strings, and must never include a synthesized "off" entry.
    expect(ids).not.toContain("off");
    expect(ids).toContain("low");
    expect(ids).toContain("medium");
    expect(ids).toContain("high");
  });

  it("throws (or otherwise reports clearly) for an unknown provider/model pair", () => {
    const models = buildModels(twoProviderConfigs());

    expect(() => describeModelInfo(models, "nope", "plain-model")).toThrow();
    expect(() => describeModelInfo(models, "acme", "nope")).toThrow();
  });

  it("threads the configured base URL onto each Model (not left empty)", () => {
    const models = buildModels(twoProviderConfigs());

    const model = models.getModel("acme", "plain-model");
    // Finding 1: pi-ai only ever rewrites baseUrl from auth.baseUrl inside
    // applyAuth; provider.baseUrl is never read on the request path, so it
    // must be set on the model itself.
    expect(model?.baseUrl).toBe("https://acme.example/v1");
  });

  it("normalizes a base URL with no /v1 by appending it", () => {
    const models = buildModels([
      {
        id: "gw",
        baseURL: "https://gateway.example",
        apiKey: "k",
        models: [{ code: "m" }],
      },
    ]);

    expect(models.getModel("gw", "m")?.baseUrl).toBe("https://gateway.example/v1");
  });

  it("leaves a base URL already ending in /v1 unchanged", () => {
    const models = buildModels([
      {
        id: "gw",
        baseURL: "https://gateway.example/v1",
        apiKey: "k",
        models: [{ code: "m" }],
      },
    ]);

    expect(models.getModel("gw", "m")?.baseUrl).toBe("https://gateway.example/v1");
  });

  it("strips a trailing slash before normalizing", () => {
    const models = buildModels([
      {
        id: "gw",
        baseURL: "https://gateway.example/",
        apiKey: "k",
        models: [{ code: "m" }],
      },
    ]);

    expect(models.getModel("gw", "m")?.baseUrl).toBe("https://gateway.example/v1");
  });
});
