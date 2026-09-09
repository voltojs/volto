import { describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { buildModels, describeModelInfo, resolveConfiguredApiKey, type PiAiProviderConfig } from "../collection.js";
import { createPiAiModelPortFromModels } from "../model-port.js";

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
      kind: "custom",
      id: "acme",
      baseURL: "https://acme.example/v1",
      apiKey: "acme-key",
      models: [{ code: "plain-model", contextWindow: 8192, maxOutputTokens: 2048 }],
    },
    {
      kind: "custom",
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
        kind: "custom",
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
        kind: "custom",
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
        kind: "custom",
        id: "gw",
        baseURL: "https://gateway.example/",
        apiKey: "k",
        models: [{ code: "m" }],
      },
    ]);

    expect(models.getModel("gw", "m")?.baseUrl).toBe("https://gateway.example/v1");
  });
});

describe("catalog provider registration", () => {
  function catalogConfig(overrides: Partial<Extract<PiAiProviderConfig, { kind: "catalog" }>> = {}): PiAiProviderConfig {
    return {
      kind: "catalog",
      id: "my-deepseek",
      piProvider: "deepseek",
      apiKey: "ds-key",
      modelCodes: ["deepseek-v4-flash"],
      ...overrides,
    };
  }

  it("resolves a catalog model via getModel(volto-id, code)", () => {
    const models = buildModels([catalogConfig()]);

    const model = models.getModel("my-deepseek", "deepseek-v4-flash");
    expect(model).toBeDefined();
    expect(model?.provider).toBe("my-deepseek");
  });

  it("registers no models for a provider whose selected model list is empty", () => {
    const models = buildModels([catalogConfig({ modelCodes: [] })]);

    expect(models.getModel("my-deepseek", "deepseek-v4-flash")).toBeUndefined();
  });

  // Rule 1 (pinned): a catalog model's baseUrl is pi-ai's own catalog value,
  // untouched. deepseek's real baseUrl ("https://api.deepseek.com") does NOT
  // end in "/v1" — normalizeBaseUrl would corrupt it by appending "/v1", so
  // this is the assertion that pins the rule.
  it("does not run a catalog model's baseUrl through normalizeBaseUrl", () => {
    const models = buildModels([catalogConfig()]);

    const model = models.getModel("my-deepseek", "deepseek-v4-flash");
    const catalogEntry = getBuiltinModel("deepseek", "deepseek-v4-flash");

    expect(model?.baseUrl).toBe(catalogEntry.baseUrl);
    expect(model?.baseUrl).toBe("https://api.deepseek.com");
  });

  it("replaces a catalog model's baseUrl with the configured override, verbatim", () => {
    // The override reaches the request path only via the MODEL's own baseUrl
    // (pi-ai never reads provider.baseUrl when streaming), and is used as
    // typed: a catalog provider's dialect may not be openai-completions, so
    // the "/v1" rule that applies to hand-declared gateways cannot apply here.
    const models = buildModels([
      catalogConfig({ baseURL: "https://mirror.internal/deepseek" }),
    ]);

    const model = models.getModel("my-deepseek", "deepseek-v4-flash");
    expect(model?.baseUrl).toBe("https://mirror.internal/deepseek");
  });

  it("keeps the catalog's own baseUrl when no override is configured", () => {
    const models = buildModels([catalogConfig()]);
    expect(models.getModel("my-deepseek", "deepseek-v4-flash")?.baseUrl).toBe(
      "https://api.deepseek.com",
    );
  });

  it("declares a non-empty efforts list for a reasoning-capable catalog model", () => {
    const models = buildModels([catalogConfig()]);

    const info = describeModelInfo(models, "my-deepseek", "deepseek-v4-flash");

    expect(info.reasoning).toBeDefined();
    expect(info.reasoning?.efforts.length).toBeGreaterThan(0);
    expect(info.reasoning?.efforts.map((e) => e.id)).not.toContain("off");
  });

  it("omits `reasoning` entirely for a non-reasoning catalog model", () => {
    const models = buildModels([
      catalogConfig({ id: "my-openai", piProvider: "openai", modelCodes: ["gpt-4o-mini"] }),
    ]);

    const info = describeModelInfo(models, "my-openai", "gpt-4o-mini");

    expect(info.reasoning).toBeUndefined();
  });

  it("throws for an unknown pi-ai builtin provider id", () => {
    expect(() => buildModels([catalogConfig({ piProvider: "not-a-real-provider" })])).toThrow();
  });
});

describe("custom provider: reasoning config flag", () => {
  it("declares a non-empty efforts list when a custom model is flagged reasoning: true", () => {
    const models = buildModels([
      {
        kind: "custom",
        id: "gw",
        baseURL: "https://gateway.example/v1",
        apiKey: "k",
        models: [{ code: "m", reasoning: true }],
      },
    ]);

    const info = describeModelInfo(models, "gw", "m");

    expect(info.reasoning).toBeDefined();
    expect(info.reasoning?.efforts.length).toBeGreaterThan(0);
    expect(info.reasoning?.efforts.map((e) => e.id)).not.toContain("off");
  });

  it("still normalizes baseUrl for a custom model flagged reasoning: true", () => {
    const models = buildModels([
      {
        kind: "custom",
        id: "gw",
        baseURL: "https://gateway.example",
        apiKey: "k",
        models: [{ code: "m", reasoning: true }],
      },
    ]);

    expect(models.getModel("gw", "m")?.baseUrl).toBe("https://gateway.example/v1");
  });

  it("defaults to reasoning: false (no `reasoning` field) when the flag is omitted", () => {
    const models = buildModels([
      {
        kind: "custom",
        id: "gw",
        baseURL: "https://gateway.example/v1",
        apiKey: "k",
        models: [{ code: "m" }],
      },
    ]);

    const info = describeModelInfo(models, "gw", "m");
    expect(info.reasoning).toBeUndefined();
  });
});

describe("resolveConfiguredApiKey", () => {
  it("returns the configured key for a catalog provider", () => {
    const providers: PiAiProviderConfig[] = [
      {
        kind: "catalog",
        id: "my-deepseek",
        piProvider: "deepseek",
        apiKey: "ds-key",
        modelCodes: ["deepseek-v4-flash"],
      },
    ];

    expect(resolveConfiguredApiKey(providers, "my-deepseek")).toBe("ds-key");
  });

  it("returns undefined for a custom provider (key is already baked into its auth)", () => {
    const providers: PiAiProviderConfig[] = [
      { kind: "custom", id: "acme", baseURL: "https://acme.example/v1", apiKey: "acme-key", models: [] },
    ];

    expect(resolveConfiguredApiKey(providers, "acme")).toBeUndefined();
  });

  it("returns undefined for an unknown provider id", () => {
    expect(resolveConfiguredApiKey([], "nope")).toBeUndefined();
  });
});

describe("catalog provider: per-request apiKey injection", () => {
  const providers: PiAiProviderConfig[] = [
    {
      kind: "catalog",
      id: "my-deepseek",
      piProvider: "deepseek",
      apiKey: "ds-key",
      modelCodes: ["deepseek-v4-flash"],
    },
  ];

  it("reaches Models.streamSimple's request options via createPiAiModelPortFromModels, not baked into a stored auth object", async () => {
    const models = buildModels(providers);
    const apiKey = resolveConfiguredApiKey(providers, "my-deepseek");
    expect(apiKey).toBe("ds-key");

    // Spy on the `Models` collection's own `streamSimple` (the seam
    // `model-port.ts`'s stream() actually calls) to observe the options it
    // is invoked with, without performing real network I/O.
    const streamSimpleSpy = vi.spyOn(models, "streamSimple").mockReturnValue({
      async *[Symbol.asyncIterator]() {
        // empty stream: enough for normalizeStream to complete without I/O.
      },
    } as never);

    const port = createPiAiModelPortFromModels(models, "my-deepseek", undefined, apiKey);
    const events = port.stream({ model: "deepseek-v4-flash", messages: [], tools: [] });
    for await (const _event of events) {
      // drain
    }

    expect(streamSimpleSpy).toHaveBeenCalledTimes(1);
    const [, , forwardedOptions] = streamSimpleSpy.mock.calls[0]!;
    // Rule 2: the key travels as a per-request option, never baked into a
    // `fixedApiKeyAuth`-style object on the provider itself.
    expect(forwardedOptions?.apiKey).toBe("ds-key");
  });
});
