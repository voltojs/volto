import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelInputValue, ModelInputLimits } from "@voltojs/core";

/** A single model surfaced from pi-ai's built-in catalog. */
export interface CatalogModel {
  code: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning: boolean;
  /** Input modalities from pi-ai's catalog (verbatim). */
  input?: ModelInputValue;
  /** Provider input limits from pi-ai's catalog (verbatim; absent for most models). */
  inputLimits?: ModelInputLimits;
}

/** A single provider surfaced from pi-ai's built-in catalog. */
export interface CatalogProvider {
  id: string;
  name: string;
  /**
   * The provider's own address, when it declares one. Surfaced so a settings
   * UI can show it as the default a per-provider override would replace —
   * these differ per provider in both shape (`/v1` suffix or not) and API
   * dialect, so it is never synthesized or normalized.
   */
  baseUrl?: string;
  models: CatalogModel[];
}

/**
 * Project pi-ai's built-in provider catalog into the shape volto's settings
 * UI can offer. Pure function over pi-ai's statically generated catalog: no
 * network, no I/O.
 *
 * Only providers with `auth.apiKey` are listed. The settings UI can only
 * collect a single API key from the user, so an OAuth-only provider (today,
 * only `openai-codex`) would be unusable there and is excluded. Providers
 * that have both `apiKey` and `oauth` (e.g. `anthropic`, `openrouter`,
 * `xai`) are kept: the apiKey path still works even though OAuth is also
 * available.
 */
export function listCatalogProviders(): CatalogProvider[] {
  return builtinProviders()
    .filter((provider) => provider.auth?.apiKey !== undefined)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      models: provider.getModels().map((model) => ({
        code: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        // Taken directly from pi-ai's model metadata, not inferred.
        reasoning: model.reasoning,
        // Verbatim from pi-ai's model metadata, same as reasoning above.
        input: model.input,
        ...(model.inputLimits === undefined ? {} : { inputLimits: model.inputLimits }),
      })),
    }))
    // Dynamic providers (e.g. "radius") report no models until
    // refreshModels() runs; a settings UI has nothing to offer for them yet,
    // so exclude providers with an empty static model list.
    .filter((provider) => provider.models.length > 0);
}
