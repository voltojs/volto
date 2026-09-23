import {
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  type Api,
  type ApiKeyAuth,
  type Model,
  type Models,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type {
  ModelInputValue,
  ModelReasoningInfo,
  ReasoningEffortId,
  ResolvedModelInfo,
} from "@volto/core";

/**
 * One configured pi-ai provider. Either a reference into pi-ai's built-in
 * catalog (`kind: "catalog"`) or a hand-declared OpenAI-completions gateway
 * (`kind: "custom"`, unchanged from phase two aside from the new `reasoning`
 * flag on each model).
 */
export type PiAiProviderConfig =
  | {
      kind: "catalog";
      /**
       * volto-side config id. NOT the key models are registered under — a
       * catalog provider registers under its pi-ai id, see
       * {@link registryProviderId}.
       */
      id: string;
      /** pi-ai's built-in provider id, e.g. "openai", "deepseek". */
      piProvider: string;
      apiKey?: string;
      /**
       * Replaces the catalog provider's own address (a self-hosted mirror or
       * a corporate gateway). Used verbatim — see {@link buildCatalogProvider}.
       */
      baseURL?: string;
      /** User-selected model codes; an empty array means no usable models. */
      modelCodes: string[];
      /**
       * Per-model user override of pi-ai's catalog `reasoning` flag.
       * `false` forces the model non-reasoning; `true` forces reasoning
       * (default thinking levels when the catalog itself declares none).
       * A model absent from this map keeps the catalog's own value.
       */
      reasoningOverrides?: Record<string, boolean>;
      /**
       * Per-model user override of pi-ai's catalog `input` modalities.
       * Absent = follow the catalog. Valid values: ["text"] / ["text","image"]
       * (the store validates before this layer).
       */
      inputOverrides?: Record<string, ModelInputValue>;
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
        /**
         * Input modalities for a hand-declared gateway model, tri-state
         * (spec §7 / D2): absent means UNKNOWN, and UNKNOWN still sends
         * images — a vanished image path is harder to diagnose than a
         * provider 400. Only an explicit `["text"]` gates them off.
         */
        input?: ModelInputValue;
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
 * Input knowledge that `Model.input` alone cannot express.
 *
 * pi-ai reads `Model.input` on the wire path to decide whether to actually
 * attach images, and that value is binary-per-value — it cannot express
 * "the config never said". A hand-declared model with no `input` therefore
 * ships image-capable (spec §7: UNKNOWN is not text-only). Catalog models
 * are authoritative from their (possibly overridden) `Model.input`; custom
 * and synthesized models are registered here so `describeModelInfo` can
 * leave `input` absent when the config never said.
 */
const inputDeclarations = new WeakMap<object, ModelInputValue | undefined>();

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
  const model: Model<"openai-completions"> = {
    id: entry.code,
    name: entry.name ?? entry.code,
    api: "openai-completions",
    provider: providerId,
    baseUrl: normalizeBaseUrl(providerBaseUrl),
    reasoning: entry.reasoning ?? false,
    // Three-state, per spec §7 / D3: an undeclared custom model stays
    // image-capable on the wire — treating UNKNOWN as text-only would
    // silently disable images for every gateway that cannot describe its
    // own models. The declaration truth lives in inputDeclarations below.
    // Spread copies: core's ModelInputValue is readonly, pi-ai's Model.input
    // is mutable — same elements, fresh array.
    input: [...(entry.input ?? ["text", "image"])],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: entry.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
  };
  inputDeclarations.set(model, entry.input);
  return model;
}

/**
 * Whether pi-ai's `developer` system role is safe for one catalog model.
 *
 * pi-ai sends the system prompt as `role: "developer"` whenever the model is
 * reasoning-capable and `compat.supportsDeveloperRole` is not explicitly
 * false — and `detectCompat` defaults that to true for any provider it does
 * not recognize. `developer` is an OpenAI-specific role: a third-party
 * OpenAI-compatible gateway that does not implement it takes the message but
 * does not treat it as a system instruction, so the whole system prompt is
 * silently demoted (observed with `xiaomi-token-plan-cn`, which pi-ai 0.85.1
 * does not flag).
 *
 * Inverting the default is the safer error: a provider that DOES support
 * `developer` still honours `system`, while one that does not silently drops
 * the instructions. So only the providers known to implement it keep it.
 */
function supportsDeveloperRole(piProvider: string, modelId: string): boolean {
  if (piProvider === "openai") return true;
  // OpenRouter proxies the upstream role through for these two families;
  // matches pi-ai's own `isOpenRouterDeveloperRoleModel` rule.
  if (piProvider === "openrouter") {
    return modelId.startsWith("openai/") || modelId.startsWith("anthropic/");
  }
  return false;
}

/**
 * Wrap one of pi-ai's built-in catalog providers as a `Provider` registered
 * under pi-ai's own provider id, restricted to the user's selected model
 * codes.
 *
 * `baseUrl` on each model is left exactly as pi-ai's catalog gives it — no
 * `normalizeBaseUrl` — per rule 1 in the task brief: that helper exists only
 * for hand-declared gateways where phase two found pi-ai does no
 * normalization of its own; applying it to an already-correct catalog
 * address would corrupt it.
 *
 * `config.baseURL`, when set, replaces that address on the provider AND on
 * every model (pi-ai reads the model's own `baseUrl` on the request path —
 * see {@link buildModel}). It too is used verbatim: catalog addresses differ
 * per provider in both shape (`https://api.openai.com/v1` vs
 * `https://api.deepseek.com`) and API dialect, so the openai-completions
 * `/v1` rule cannot be applied to an override for an arbitrary one.
 *
 * `model.provider` is left as pi-ai's own provider id, and the provider is
 * registered under that same id rather than volto's config id. Both must
 * agree — `Models.stream`/`streamSimple` resolve the owning provider via
 * `model.provider` looked up in the map `setProvider` populates
 * (dist/models.js: `requireProvider` reads `this.providers.get(
 * model.provider)`). Keeping pi-ai's id on both sides is what preserves
 * `detectCompat`, which decides the wire format (system role, max-tokens
 * field name, thinking-block format) from `model.provider` first and
 * `model.baseUrl` second: rewriting the id to volto's own left only the URL
 * check standing, and a configured `baseURL` override knocks that out too —
 * silently switching providers like `xai`/`openrouter`/`cerebras` onto the
 * wrong wire format. The cost is that one pi-ai provider can be configured
 * only once per collection; `buildModels` rejects a duplicate rather than
 * letting the second registration silently replace the first (including its
 * API key).
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
/**
 * One catalog model entry the user enabled whose code is not in this build's
 * pi-ai catalog (a newly released model, or a typo). Synthesized only when
 * the user also declared `reasoning: true` — otherwise the code simply is
 * not in the Models collection, same as before.
 *
 * Template choice:
 * - First reasoning-capable catalog model → inherit its thinkingLevelMap
 *   (real efforts for that provider family).
 * - No reasoning model in the catalog at all → take any catalog model as a
 *   structural template, force `reasoning: true` and drop `thinkingLevelMap`
 *   so `getSupportedThinkingLevels` yields the same default level set a
 *   hand-declared custom model gets (minimal/low/medium/high).
 */
function synthesizeUnknownCatalogModel(
  source: Provider,
  code: string,
  piProvider: string,
  baseURL: string | undefined,
): Model<Api> {
  const catalogModels = source.getModels();
  const reasoningTemplate = catalogModels.find((m) => m.reasoning);
  const structural = reasoningTemplate ?? catalogModels[0];

  if (structural) {
    const synthesized = {
      ...structural,
      id: code,
      name: code,
      reasoning: true,
      // No reasoning template: drop any inherited map so the default level
      // set applies. `undefined` is equivalent to absent for the optional
      // access in getSupportedThinkingLevels.
      ...(reasoningTemplate ? {} : { thinkingLevelMap: undefined }),
      ...(baseURL ? { baseUrl: baseURL } : {}),
      // Same reasoning as inputDeclarations below: the template's
      // inputLimits are directory facts about the TEMPLATE, not about a
      // code the catalog does not know. Clear them so describeModelInfo's
      // `!== undefined` gate reports absence (spec §4.1 / D5: "absent for
      // custom/synthesized models") instead of fabricating a known fact.
      inputLimits: undefined,
    } as Model<Api>;
    // Inherited `input` is structural, not a statement about this unknown
    // code — leave input UNKNOWN rather than trusting the template.
    inputDeclarations.set(synthesized, undefined);
    return synthesized;
  }

  // Empty catalog — degrade to a custom-like OpenAI-completions stub.
  const stub = {
    id: code,
    name: code,
    api: "openai-completions",
    provider: piProvider,
    baseUrl: baseURL ?? source.baseUrl ?? "https://api.openai.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  } satisfies Model<"openai-completions"> as Model<Api>;
  inputDeclarations.set(stub, undefined);
  return stub;
}

function buildCatalogProvider(config: CatalogProviderConfig): Provider {
  const source = builtinProviders().find((provider) => provider.id === config.piProvider);
  if (!source) {
    throw new Error(`pi-ai: unknown catalog provider "${config.piProvider}"`);
  }

  const selected = new Set(config.modelCodes);
  const catalogModels = source.getModels();
  const knownIds = new Set(catalogModels.map((m) => m.id));

  const models = catalogModels
    .filter((model) => selected.has(model.id))
    .map((model) => {
      // Local so `!== undefined` narrows the possibly-undefined indexed
      // read (noUncheckedIndexedAccess does not narrow element access).
      const inputOverride = config.inputOverrides?.[model.id];
      return {
        ...model,
        // Explicit, so it no longer depends on detectCompat's "unknown provider
        // is a standard OpenAI endpoint" default — see supportsDeveloperRole.
        // Only the two OpenAI dialects read this key; the anthropic-messages
        // and bedrock compat shapes do not declare it, so leave theirs alone.
        ...(model.api === "openai-completions" || model.api === "openai-responses"
          ? {
              compat: {
                ...model.compat,
                supportsDeveloperRole: supportsDeveloperRole(config.piProvider, model.id),
              },
            }
          : {}),
        // User override wins over the catalog's own flag. Setting `reasoning:
        // true` on a catalog model that declares none still yields the default
        // thinking-level set via getSupportedThinkingLevels (see buildModel).
        ...(config.reasoningOverrides?.[model.id] !== undefined
          ? { reasoning: config.reasoningOverrides[model.id] }
          : {}),
        // Same override semantics as reasoning: absent keeps the catalog's
        // own modalities. Landing on `Model.input` also drives pi-ai's
        // transformMessages image stripping, so the declaration sticks on
        // the wire, not just in describeModelInfo. Spread copies: core's
        // ModelInputValue is readonly, pi-ai's Model.input is mutable.
        ...(inputOverride !== undefined ? { input: [...inputOverride] } : {}),
        ...(config.baseURL ? { baseUrl: config.baseURL } : {}),
      };
    });

  // Enabled codes the catalog does not know: synthesize a reasoning-capable
  // entry so describeModel / effort validation keep working instead of
  // dropping the user's declared intent on the floor.
  for (const code of config.modelCodes) {
    if (knownIds.has(code)) continue;
    if (config.reasoningOverrides?.[code] !== true) continue;
    models.push(
      synthesizeUnknownCatalogModel(source, code, config.piProvider, config.baseURL),
    );
  }

  return {
    id: config.piProvider,
    name: source.name,
    baseUrl: config.baseURL ?? source.baseUrl,
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
/**
 * The id one configured provider is registered under in the `Models`
 * collection, which is what `getModel`/`describeModelInfo` must be called
 * with — pi-ai's own provider id for catalog entries (see
 * {@link buildCatalogProvider}), the config id for hand-declared ones.
 */
export function registryProviderId(providers: PiAiProviderConfig[], configId: string): string {
  const config = providers.find((p) => p.id === configId);
  if (config === undefined) return configId;
  return config.kind === "catalog" ? config.piProvider : config.id;
}

export function buildModels(providers: PiAiProviderConfig[]): MutableModels {
  const models = createModels();
  // setProvider silently replaces an existing registration, so a collision
  // would drop one provider's models AND its API key without a word. Both
  // kinds share one namespace because a hand-declared provider registers
  // under its config id, which could equal some pi-ai provider id.
  const registered = new Map<string, string>();
  const claim = (key: string, configId: string): void => {
    const owner = registered.get(key);
    if (owner !== undefined) {
      throw new Error(
        `pi-ai: provider "${key}" is already configured (by "${owner}"); ` +
          `configure each built-in provider at most once.`,
      );
    }
    registered.set(key, configId);
  };

  for (const config of providers) {
    if (config.kind === "catalog") {
      claim(config.piProvider, config.id);
      models.setProvider(buildCatalogProvider(config));
      continue;
    }
    claim(config.id, config.id);

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
 *
 * `input` is a tri-state: catalog models publish the catalog's own
 * `input` modalities (a fact either way); custom and synthesized models
 * publish only an explicit config declaration — absence stays UNKNOWN.
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

  // Tri-state input (spec D2): custom/synthesized models answer from
  // inputDeclarations (absent = UNKNOWN → field omitted); catalog and
  // test-injected models answer from their own Model.input, a fact.
  const input = inputDeclarations.has(model)
    ? inputDeclarations.get(model)
    : model.input;
  if (input !== undefined) {
    info.input = input;
    // Transitional: vision derives from the single source until its
    // retirement lands (spec D2); wire/web still read it until then.
    info.vision = input.includes("image");
  }
  // Directory fact, read-only (D5): custom/synthesized models have none.
  if (model.inputLimits !== undefined) {
    info.inputLimits = model.inputLimits;
  }

  return info;
}
