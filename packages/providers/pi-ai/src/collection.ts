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
import type { ModelReasoningInfo, ReasoningEffortId, ResolvedModelInfo } from "@volto/core";

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
 * Normalize a configured base URL the way the old `provider-openai` port did:
 * strip trailing slashes, then append `/v1` unless the URL already ends in
 * `/v1`. pi-ai does no normalization of its own — it hands `model.baseUrl`
 * straight to the OpenAI SDK, which appends `/chat/completions` — so without
 * this, `https://api.openai.com` (no `/v1`) 404s and every pre-existing
 * `https://gateway.example` style config breaks.
 */
function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * Build the pi-ai `Model` for one hand-declared config entry. A hand-declared
 * model has no reasoning metadata: `reasoning` stays `false` and
 * `thinkingLevelMap` stays absent, so `describeModelInfo` legitimately omits
 * the `reasoning` field for it later.
 *
 * `baseUrl` must be set here, on the model itself: pi-ai only ever rewrites a
 * model's base URL from `auth.baseUrl` inside `applyAuth`
 * (dist/models.js:375), which we don't populate; `provider.baseUrl` is stored
 * but never read on the request path. pi-ai's own built-in OpenAI provider
 * confirms this is the intended shape (dist/providers/openai.js:9 sets
 * `baseUrl` on the model, not just the provider).
 */
function buildModel(
  providerId: string,
  providerBaseUrl: string,
  entry: PiAiProviderConfig["models"][number],
): Model<"openai-completions"> {
  return {
    id: entry.code,
    name: entry.name ?? entry.code,
    api: "openai-completions",
    provider: providerId,
    baseUrl: normalizeBaseUrl(providerBaseUrl),
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
      models: config.models.map((entry) => buildModel(config.id, config.baseURL, entry)),
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
          id: level as ReasoningEffortId, // branded type: effort id is published verbatim from pi-ai; core never interprets it
          name: displayName(level),
        })),
      };
      info.reasoning = reasoning;
    }
  }

  return info;
}
