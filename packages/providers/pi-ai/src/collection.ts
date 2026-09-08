import {
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  type ApiKeyAuth,
  type Model,
  type Models,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ModelReasoningInfo, ResolvedModelInfo } from "@volto/core";
import { ReasoningEffortId } from "@volto/core";

/** One configured pi-ai gateway: a hand-declared provider plus its models. */
export interface PiAiProviderConfig {
  id: string;
  name?: string;
  baseURL: string;
  apiKey?: string;
  models: Array<{
    code: string;
    name?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
  }>;
}

/** Fallbacks used only because hand-declared config models lack a real catalog entry. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Plain fixed-key auth. Deliberately not `envApiKeyAuth`: that helper reads
 * `process.env` inside pi-ai, reintroducing the env-var fallback this repo's
 * phase-one work removed. `resolve()` ignores `ctx`/`credential` and always
 * returns the configured key.
 */
function fixedApiKeyAuth(providerId: string, apiKey: string | undefined): ApiKeyAuth {
  return {
    name: `${providerId} API key`,
    resolve: async () => ({ auth: { apiKey } }),
  };
}

/**
 * Build the pi-ai `Model` for one hand-declared config entry. A hand-declared
 * model has no reasoning metadata: `reasoning` stays `false` and
 * `thinkingLevelMap` stays absent, so `describeModelInfo` legitimately omits
 * the `reasoning` field for it later.
 */
function buildModel(
  providerId: string,
  entry: PiAiProviderConfig["models"][number],
): Model<"openai-completions"> {
  return {
    id: entry.code,
    name: entry.name ?? entry.code,
    api: "openai-completions",
    provider: providerId,
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: entry.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
  };
}

/**
 * Assemble a pi-ai `Models` collection from volto's configured providers.
 * Every entry becomes a hand-declared gateway via `createProvider`; there is
 * no catalog-lookup path in this phase (that is phase three).
 */
export function buildModels(providers: PiAiProviderConfig[]): MutableModels {
  const models = createModels();

  for (const config of providers) {
    const provider = createProvider({
      id: config.id,
      name: config.name,
      baseUrl: config.baseURL,
      auth: { apiKey: fixedApiKeyAuth(config.id, config.apiKey) },
      models: config.models.map((entry) => buildModel(config.id, entry)),
      api: openAICompletionsApi(),
    });
    models.setProvider(provider);
  }

  return models;
}

/** Capitalize a pi-ai thinking-level id for display, e.g. "high" -> "High". */
function displayName(level: string): string {
  return level.length === 0 ? level : level[0]!.toUpperCase() + level.slice(1);
}

/**
 * Resolve capability metadata for one exact model. `reasoning` is present
 * only when the model is flagged `reasoning: true` and
 * `getSupportedThinkingLevels()` yields at least one non-"off" level; never a
 * synthesized off-only list (an off-only control would be byte-identical to
 * omitting the option entirely).
 */
export function describeModelInfo(models: Models, providerId: string, code: string): ResolvedModelInfo {
  const model = models.getModel(providerId, code);
  if (!model) {
    throw new Error(`pi-ai: unknown model "${code}" for provider "${providerId}"`);
  }

  const info: ResolvedModelInfo = {
    model: code,
    contextWindow: model.contextWindow,
  };

  if (model.reasoning) {
    const levels = getSupportedThinkingLevels(model).filter((level) => level !== "off");
    if (levels.length > 0) {
      const reasoning: ModelReasoningInfo = {
        efforts: levels.map((level) => ({
          id: ReasoningEffortId(level),
          name: displayName(level),
        })),
      };
      info.reasoning = reasoning;
    }
  }

  return info;
}
