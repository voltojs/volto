import { describe, expect, it } from "vitest";
import { listCatalogProviders } from "../catalog.js";

describe("listCatalogProviders", () => {
  it("returns a non-empty list where every provider has at least one model", () => {
    const providers = listCatalogProviders();

    expect(providers.length).toBeGreaterThan(0);
    for (const provider of providers) {
      expect(provider.models.length).toBeGreaterThan(0);
    }
  });

  it("excludes oauth-only providers (openai-codex has no apiKey auth)", () => {
    const providers = listCatalogProviders();

    expect(providers.some((provider) => provider.id === "openai-codex")).toBe(false);
  });

  it("includes providers with both apiKey and oauth auth (anthropic)", () => {
    const providers = listCatalogProviders();

    expect(providers.some((provider) => provider.id === "anthropic")).toBe(true);
  });

  it("carries pi-ai's own reasoning flag, not a guess: both true and false occur", () => {
    const providers = listCatalogProviders();
    const allModels = providers.flatMap((provider) => provider.models);

    expect(allModels.some((model) => model.reasoning === true)).toBe(true);
    expect(allModels.some((model) => model.reasoning === false)).toBe(true);
  });

  it("gives every provider and model non-empty id/code and name strings", () => {
    const providers = listCatalogProviders();

    for (const provider of providers) {
      expect(provider.id.length).toBeGreaterThan(0);
      expect(provider.name.length).toBeGreaterThan(0);
      for (const model of provider.models) {
        expect(model.code.length).toBeGreaterThan(0);
        expect(model.name.length).toBeGreaterThan(0);
      }
    }
  });

  it("carries pi-ai's input modalities and inputLimits verbatim", () => {
    const providers = listCatalogProviders();
    const deepseek = providers.find((p) => p.id === "deepseek");
    expect(deepseek).toBeDefined();

    const flash = deepseek!.models.find((m) => m.code === "deepseek-flash");
    expect(flash).toBeDefined();
    expect(flash!.input).toEqual(["text", "image"]);
    expect(flash!.inputLimits?.images?.resize?.maxWidth).toBe(2000);
  });
});
