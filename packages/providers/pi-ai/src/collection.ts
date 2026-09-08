import {
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  type ApiKeyAuth,
  type Model,
  type Models,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelReasoningInfo, ReasoningEffortId, ResolvedModelInfo } from "@volto/core";

/**
 * One configured pi-ai provider. Either a reference into pi-ai's built-in
 * catalog (`kind: "catalog"`) or a hand-declared OpenAI-completions gateway
 * (`kind: "custom"`, unchanged from phase two aside from the new `reasoning`
 * flag on each model).
 */
export type PiAiProviderConfig =
  | {
      kind: "catalog";
      /** volto-side config id; also the key models are registered under. */
      id: string;
      /** pi-ai's built-in provider id, e.g. "openai", "deepseek". */
      piProvider: string;
      apiKey?: string;
      /** User-selected model codes; an empty array means no usable models. */
      modelCodes: string[];
    }
  | {
      kind: "custom";
      id: string;
      name?: string;
      baseURL: string;
      apiKey?: string;
      models: Array<{
        code: string;
        name?: string;
        contextWindow?: number;
        maxOutputTokens?: number;
        reasoning?: boolean;
      }>;
    };

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

type CustomModelEntry = Extract<PiAiProviderConfig, { kind: "custom" }>["models"][number];
type CatalogProviderConfig = Extract<PiAiProviderConfig, { kind: "catalog" }>;

/**
 * Build the pi-ai `Model` for one hand-declared config entry. `reasoning`
 * comes straight from the config flag (default `false`, unchanged from phase
 * two); `thinkingLevelMap` is deliberately left unset even when
 * `reasoning: true` — `getSupportedThinkingLevels()` already yields a
 * sensible default level set (off/minimal/low/medium/high, `xhigh`/`max`
 * excluded) for a `reasoning: true` model with no explicit map
 * (dist/models.js:551-562), which is the best a generic hand-declared
 * OpenAI-completions gateway can claim without per-model level metadata.
 *
 * `baseUrl` must be set here, on the model itself: pi-ai only ever rewrites a
 * model's base URL from `auth.baseUrl` inside `applyAuth`
 * (dist/models.js:375), which we don't populate; `provider.baseUrl` is stored
 * but never read on the request path. pi-ai's own built-in OpenAI provider
 * confirms this is the intended shape (dist/providers/openai.js:9 sets
 * `baseUrl` on the model, not just the provider).
 */
function buildModel(providerId: string, providerBaseUrl: string, entry: CustomModelEntry): Model<"openai-completions"> {
  return {
    id: entry.code,
    name: entry.name ?? entry.code,
    api: "openai-completions",
    provider: providerId,
    baseUrl: normalizeBaseUrl(providerBaseUrl),
    reasoning: entry.reasoning ?? false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: entry.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
  };
}

/**
 * Wrap one of pi-ai's built-in catalog providers as a `Provider` registered
 * under volto's own config id, restricted to the user's selected model
 * codes.
 *
 * `baseUrl` on each model is left exactly as pi-ai's catalog gives it — no
 * `normalizeBaseUrl` — per rule 1 in the task brief: that helper exists only
 * for hand-declared gateways where phase two found pi-ai does no
 * normalization of its own; applying it to an already-correct catalog
 * address would corrupt it.
 *
 * `model.provider` is rewritten to `config.id` (not left as pi-ai's own
 * provider id) because `Models.stream`/`streamSimple` resolve the owning
 * provider via `model.provider` looked up in the same map `setProvider`
 * populates (dist/models.js: `requireProvider` reads `this.providers.get(
 * model.provider)`); registering under `config.id` while leaving
 * `model.provider` as pi-ai's builtin id would make every request 404 on
 * "unknown provider".
 *
 * `auth` is deliberately rebuilt as a `fixedApiKeyAuth`, NOT the original
 * catalog provider's own `ProviderAuth`. pi-ai's `resolveProviderAuthWithSignal`
 * (dist/auth/resolve.js) only takes the `overrides.apiKey` branch when
 * `options.apiKey` is defined; when a catalog provider is configured with no
 * key (`config.apiKey === undefined`), it falls through to stored
 * credentials and then to the provider's own ambient auth — for built-in
 * providers like deepseek that is `envApiKeyAuth(...)`, which reads
 * `process.env` inside pi-ai. Keeping `source.auth` here would silently
 * reintroduce an env-var fallback, violating this repo's "nothing is read
 * from the environment" invariant (see comments at top of this file and
 * apps/headless-server/src/wiring.ts). Using a fixed-key auth here — the
 * same helper the custom-provider path uses — makes the no-env-fallback
 * behavior structural rather than dependent on the UI always supplying a key.
 */
function buildCatalogProvider(config: CatalogProviderConfig): Provider {
  const source = builtinProviders().find((provider) => provider.id === config.piProvider);
  if (!source) {
    throw new Error(`pi-ai: unknown catalog provider "${config.piProvider}"`);
  }

  const selected = new Set(config.modelCodes);
  const models = source.getModels()
    .filter((model) => selected.has(model.id))
    .map((model) => ({ ...model, provider: config.id }));

  return {
    id: config.id,
    name: source.name,
    baseUrl: source.baseUrl,
    auth: { apiKey: fixedApiKeyAuth(config.id, config.apiKey) },
    getModels: () => models,
    stream: (model, context, options) => source.stream(model, context, options),
    streamSimple: (model, context, options) => source.streamSimple(model, context, options),
  };
}

/**
 * Assemble a pi-ai `Models` collection from volto's configured providers.
 * `kind: "custom"` entries become a hand-declared gateway via
 * `createProvider`, exactly as in phase two. `kind: "catalog"` entries
 * register a restricted view of one of pi-ai's built-in providers — see
 * {@link buildCatalogProvider}.
 */
export function buildModels(providers: PiAiProviderConfig[]): MutableModels {
  const models = createModels();

  for (const config of providers) {
    if (config.kind === "catalog") {
      models.setProvider(buildCatalogProvider(config));
      continue;
    }

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

/**
 * API key to inject on each `streamSimple`/`stream` request for a configured
 * provider. Catalog providers use per-request injection (rule 2): the key is
 * read straight from the live config on every call, never baked into an auth
 * object. Custom providers already bake their key into a `fixedApiKeyAuth`
 * at `buildModels()` time, so this returns `undefined` for them and the
 * caller simply omits the request-level `apiKey` option.
 */
export function resolveConfiguredApiKey(providers: PiAiProviderConfig[], providerId: string): string | undefined {
  const config = providers.find((p) => p.id === providerId);
  return config?.kind === "catalog" ? config.apiKey : undefined;
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
