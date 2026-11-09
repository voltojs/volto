import { describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { buildModels, describeModelInfo, resolveConfiguredApiKey, resolveProviderProtocol, type PiAiProviderConfig, type ProviderProtocol } from "../collection.js";
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

// Module scope: shared by the "catalog provider registration" tests below and
// the "describeModelInfo.input" tests (which assert on its inputLimits).
function catalogConfig(overrides: Partial<Extract<PiAiProviderConfig, { kind: "catalog" }>> = {}): PiAiProviderConfig {
  return {
    kind: "catalog",
    id: "my-deepseek",
    piProvider: "deepseek",
    apiKey: "ds-key",
    modelCodes: ["deepseek-flash"],
    ...overrides,
  };
}

describe("provider protocol resolution", () => {
  it("defaults to the catalog api", () => {
    const config = catalogConfig({ protocol: "auto" });
    expect(resolveProviderProtocol(config, "deepseek-flash", "openai-completions"))
      .toBe("openai-completions");
  });

  it("lets a model protocol override the provider protocol", () => {
    const config = catalogConfig({
      protocol: "openai-responses",
      modelProtocols: { "deepseek-flash": "anthropic-messages" },
    });
    expect(resolveProviderProtocol(config, "deepseek-flash", "openai-completions"))
      .toBe("anthropic-messages");
  });

  it("defaults custom providers to openai-completions", () => {
    const config: PiAiProviderConfig = {
      kind: "custom",
      id: "acme",
      baseURL: "https://acme.example/v1",
      models: [{ code: "plain-model" }],
    };
    expect(resolveProviderProtocol(config, "plain-model")).toBe("openai-completions");
  });

  it("rejects an unknown protocol instead of silently degrading", () => {
    const config = catalogConfig({ protocol: "nope" as ProviderProtocol });
    expect(() => buildModels([config])).toThrow(/protocol/i);
  });
});

describe("catalog provider registration", () => {
  it("resolves a catalog model via getModel(pi-ai provider id, code)", () => {
    const models = buildModels([catalogConfig()]);

    const model = models.getModel("deepseek", "deepseek-flash");
    expect(model).toBeDefined();
    // pi-ai's own id, kept on both the model and the registration so
    // detectCompat still recognizes the provider.
    expect(model?.provider).toBe("deepseek");
  });

  it("registers no models for a provider whose selected model list is empty", () => {
    const models = buildModels([catalogConfig({ modelCodes: [] })]);

    expect(models.getModel("deepseek", "deepseek-flash")).toBeUndefined();
  });

  // Rule 1 (pinned): a catalog model's baseUrl is pi-ai's own catalog value,
  // untouched. deepseek's real baseUrl ("https://api.deepseek.com") does NOT
  // end in "/v1" — normalizeBaseUrl would corrupt it by appending "/v1", so
  // this is the assertion that pins the rule.
  it("does not run a catalog model's baseUrl through normalizeBaseUrl", () => {
    const models = buildModels([catalogConfig()]);

    const model = models.getModel("deepseek", "deepseek-flash");
    const catalogEntry = getBuiltinModel("deepseek", "deepseek-flash");

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

    const model = models.getModel("deepseek", "deepseek-flash");
    expect(model?.baseUrl).toBe("https://mirror.internal/deepseek");
  });

  it("keeps the catalog's own baseUrl when no override is configured", () => {
    const models = buildModels([catalogConfig()]);
    expect(models.getModel("deepseek", "deepseek-flash")?.baseUrl).toBe(
      "https://api.deepseek.com",
    );
  });

  it("marks a third-party catalog model as not supporting the developer role", () => {
    // pi-ai sends the system prompt as role "developer" when the model is
    // reasoning-capable and compat.supportsDeveloperRole is not explicitly
    // false — and detectCompat defaults that to true for any provider it
    // does not recognize. A gateway that does not implement the role takes
    // the message but does not treat it as a system instruction, so the
    // whole system prompt is silently demoted.
    const models = buildModels([
      { kind: "catalog", id: "v", piProvider: "xiaomi-token-plan-cn", modelCodes: ["mimo-v2.6-pro"] },
    ]);
    const model = models.getModel("xiaomi-token-plan-cn", "mimo-v2.6-pro");
    expect(model?.reasoning).toBe(true);
    expect(model?.compat).toMatchObject({ supportsDeveloperRole: false });
  });

  it("keeps the developer role for the providers that implement it", () => {
    const openai = buildModels([
      { kind: "catalog", id: "v", piProvider: "openai", modelCodes: ["gpt-4o-mini"] },
    ]);
    expect(openai.getModel("openai", "gpt-4o-mini")?.compat).toMatchObject({
      supportsDeveloperRole: true,
    });
  });

  it("applies a user reasoning override on a catalog model, winning over pi-ai", () => {
    // deepseek-flash is reasoning-capable in pi-ai's catalog; a stored
    // `false` override must suppress it. The inverse (forcing `true` on a
    // non-reasoning model) is covered by getSupportedThinkingLevels' default
    // level set for a `reasoning: true` model with no explicit map.
    const forcedOff = buildModels([
      {
        kind: "catalog",
        id: "v",
        piProvider: "deepseek",
        modelCodes: ["deepseek-flash"],
        reasoningOverrides: { "deepseek-flash": false },
      },
    ]);
    expect(forcedOff.getModel("deepseek", "deepseek-flash")?.reasoning).toBe(false);
    expect(describeModelInfo(forcedOff, "deepseek", "deepseek-flash").reasoning).toBeUndefined();

    // No override: the catalog's own flag survives untouched.
    const untouched = buildModels([catalogConfig()]);
    expect(untouched.getModel("deepseek", "deepseek-flash")?.reasoning).toBe(true);
  });

  it("synthesizes an unknown catalog code from the first reasoning model when the user forces reasoning on", () => {
    // deepseek-fantasy is not in pi-ai's deepseek catalog (only deepseek-flash
    // and deepseek-v4-pro).
    // Without synthesis, describeModel would throw and the settings form
    // would lose the user's checked reasoning flag on reload.
    const models = buildModels([
      {
        kind: "catalog",
        id: "v",
        piProvider: "deepseek",
        modelCodes: ["deepseek-fantasy", "deepseek-flash"],
        reasoningOverrides: { "deepseek-fantasy": true },
      },
    ]);

    const synthesized = models.getModel("deepseek", "deepseek-fantasy");
    expect(synthesized?.reasoning).toBe(true);
    // Efforts come from the catalog's first reasoning model (deepseek-flash).
    const info = describeModelInfo(models, "deepseek", "deepseek-fantasy");
    expect(info.reasoning?.efforts.map((e) => e.id)).toEqual(
      describeModelInfo(models, "deepseek", "deepseek-flash").reasoning?.efforts.map(
        (e) => e.id,
      ),
    );
  });

  it("does not synthesize an unknown catalog code without a reasoning override", () => {
    const models = buildModels([
      {
        kind: "catalog",
        id: "v",
        piProvider: "deepseek",
        modelCodes: ["deepseek-fantasy", "deepseek-flash"],
      },
    ]);
    expect(models.getModel("deepseek", "deepseek-fantasy")).toBeUndefined();
    expect(() => describeModelInfo(models, "deepseek", "deepseek-fantasy")).toThrow();
  });

  it("preserves the catalog model's other compat fields while overriding the role", () => {
    const models = buildModels([catalogConfig()]);
    const model = models.getModel("deepseek", "deepseek-flash");
    // deepseek declares these itself; overriding one compat key must not
    // drop the rest (which decide the max-tokens field name and the
    // thinking-block wire format).
    expect(model?.compat).toMatchObject({
      maxTokensField: "max_tokens",
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
      supportsDeveloperRole: false,
    });
  });

  it("rejects configuring the same built-in provider twice", () => {
    // setProvider silently replaces, so the second registration would drop
    // the first one's models and API key without a word.
    expect(() =>
      buildModels([
        catalogConfig({ id: "first" }),
        catalogConfig({ id: "second", apiKey: "other-key" }),
      ]),
    ).toThrow(/already configured/);
  });

  it("rejects a hand-declared provider whose id collides with a registered catalog provider", () => {
    expect(() =>
      buildModels([
        catalogConfig(),
        { kind: "custom", id: "deepseek", baseURL: "https://gw.example", apiKey: "k", models: [{ code: "m" }] },
      ]),
    ).toThrow(/already configured/);
  });

  it("declares a non-empty efforts list for a reasoning-capable catalog model", () => {
    const models = buildModels([catalogConfig()]);

    const info = describeModelInfo(models, "deepseek", "deepseek-flash");

    expect(info.reasoning).toBeDefined();
    expect(info.reasoning?.efforts.length).toBeGreaterThan(0);
    expect(info.reasoning?.efforts.map((e) => e.id)).not.toContain("off");
  });

  it("omits `reasoning` entirely for a non-reasoning catalog model", () => {
    const models = buildModels([
      catalogConfig({ id: "my-openai", piProvider: "openai", modelCodes: ["gpt-4o-mini"] }),
    ]);

    const info = describeModelInfo(models, "openai", "gpt-4o-mini");

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

describe("describeModelInfo.input", () => {
  it("publishes catalog input modalities verbatim (both image-capable and text-only occur)", () => {
    // gpt-4o is ["text","image"] and deepseek-v4-pro is ["text"] in
    // pi-ai's catalog — both are known facts, not guesses.
    const models = buildModels([
      { kind: "catalog", id: "v", piProvider: "openai", modelCodes: ["gpt-4o"] },
      { kind: "catalog", id: "d", piProvider: "deepseek", modelCodes: ["deepseek-v4-pro"] },
    ]);

    expect(describeModelInfo(models, "openai", "gpt-4o").input).toEqual([
      "text",
      "image",
    ]);
    expect(describeModelInfo(models, "deepseek", "deepseek-v4-pro").input).toEqual([
      "text",
    ]);
  });

  it("publishes an explicit custom input declaration and keeps pi-ai's wire value in sync", () => {
    const models = buildModels([
      {
        kind: "custom",
        id: "gw",
        baseURL: "https://gateway.example/v1",
        apiKey: "k",
        models: [{ code: "vlm", input: ["text", "image"] }],
      },
    ]);

    expect(describeModelInfo(models, "gw", "vlm").input).toEqual(["text", "image"]);
    // Wire path: pi-ai attaches images only when Model.input lists "image".
    expect(models.getModel("gw", "vlm")?.input).toEqual(["text", "image"]);
  });

  it("publishes an explicit custom text-only declaration", () => {
    const models = buildModels([
      {
        kind: "custom",
        id: "gw",
        baseURL: "https://gateway.example/v1",
        apiKey: "k",
        models: [{ code: "text-only", input: ["text"] }],
      },
    ]);

    expect(describeModelInfo(models, "gw", "text-only").input).toEqual(["text"]);
    expect(models.getModel("gw", "text-only")?.input).toEqual(["text"]);
  });

  it("leaves input absent for a custom model with no declaration (UNKNOWN, not text-only)", () => {
    const models = buildModels([
      {
        kind: "custom",
        id: "gw",
        baseURL: "https://gateway.example/v1",
        apiKey: "k",
        models: [{ code: "mystery" }],
      },
    ]);

    const info = describeModelInfo(models, "gw", "mystery");
    expect(info.input).toBeUndefined();
    // UNKNOWN must not gate the wire path (spec §7): the registered model
    // still ships image-capable so a gateway that cannot describe itself
    // does not silently lose images.
    expect(models.getModel("gw", "mystery")?.input).toEqual(["text", "image"]);
  });

  it("leaves input absent for a synthesized unknown catalog code", () => {
    const models = buildModels([
      {
        kind: "catalog",
        id: "v",
        piProvider: "deepseek",
        modelCodes: ["deepseek-fantasy", "deepseek-flash"],
        reasoningOverrides: { "deepseek-fantasy": true },
      },
    ]);

    const info = describeModelInfo(models, "deepseek", "deepseek-fantasy");
    expect(info.input).toBeUndefined();
    // inputLimits is a directory fact (D5): an unknown code has no catalog
    // entry, so inheriting the synthesis template's limits would fabricate a
    // "known" fact for a model that does not exist.
    expect(info.inputLimits).toBeUndefined();
  });

  it("materializes an unknown catalog code from an input override alone and honors it", () => {
    // No reasoning override: a stored input declaration alone must both
    // synthesize the model (or the code would vanish from the collection)
    // and land on Model.input + describeModelInfo, so wire behavior
    // (transformMessages stripping) and the capability answer agree.
    const models = buildModels([
      {
        kind: "catalog",
        id: "v",
        piProvider: "deepseek",
        modelCodes: ["deepseek-fantasy", "deepseek-flash"],
        inputOverrides: { "deepseek-fantasy": ["text"] },
      },
    ]);

    const synthesized = models.getModel("deepseek", "deepseek-fantasy");
    expect(synthesized).toBeDefined();

    const info = describeModelInfo(models, "deepseek", "deepseek-fantasy");
    expect(info.input).toEqual(["text"]);
    expect(synthesized?.input).toEqual(["text"]);
    // inputLimits stays a neutralized directory fact (D5) regardless of the
    // input override — the template's limits are not this code's facts.
    expect(info.inputLimits).toBeUndefined();
  });

  it("passes the catalog's inputLimits through untouched", () => {
    const models = buildModels([catalogConfig()]); // modelCodes: ["deepseek-flash"]
    const info = describeModelInfo(models, "deepseek", "deepseek-flash");

    expect(info.inputLimits?.images?.resize).toEqual({
      maxWidth: 2000,
      maxHeight: 2000,
      maxBytes: 4718592,
      jpegQuality: 80,
    });
  });

  it("applies a stored input override over the catalog's own modalities", () => {
    const models = buildModels([
      {
        kind: "catalog",
        id: "v",
        piProvider: "deepseek",
        modelCodes: ["deepseek-flash"],
        inputOverrides: { "deepseek-flash": ["text"] },
      },
    ]);

    const info = describeModelInfo(models, "deepseek", "deepseek-flash");
    expect(info.input).toEqual(["text"]);
    // The override lands on Model.input, so pi-ai's transformMessages
    // strips images on the wire too — declaration and behavior agree.
    expect(models.getModel("deepseek", "deepseek-flash")?.input).toEqual(["text"]);
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
        modelCodes: ["deepseek-flash"],
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
      modelCodes: ["deepseek-flash"],
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

    const port = createPiAiModelPortFromModels(models, "deepseek", undefined, apiKey);
    const events = port.stream({ model: "deepseek-flash", messages: [], tools: [] });
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
