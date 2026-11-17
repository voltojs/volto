import {
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  type Api,
  type ApiKeyAuth,
  type Model,
  type ModelThinkingLevel,
  type Models,
  type MutableModels,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type {
  ModelCacheCapability,
  ModelInputValue,
  ModelReasoningInfo,
  ModelThinkingLevelInfo,
  ReasoningEffortId,
  ResolvedModelInfo,
} from "@voltojs/core";

/**
 * The seven thinking levels in display order — the full set pi-ai can map a
 * model's reasoning onto. Mirrors pi-ai's `MODEL_THINKING_LEVELS` (from
 * `providers/model-schema`, which includes `"off"`; pi-ai's other constant
 * `THINKING_LEVELS` excludes `"off"` and is the request-side effort enum).
 * Kept as this package's own literal so consumers (settings editor) do not
 * reach into pi-ai internals; must stay in sync with pi-ai's extended set.
 */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** One thinking-level id, e.g. "low" or "xhigh". */
export type ThinkingLevelId = (typeof THINKING_LEVELS)[number];

/**
 * User's per-level override of one model's `thinkingLevelMap`. A string
 * value marks the level supported and sent on the wire as that value;
 * `null` marks it unsupported; an absent key inherits the catalog (or, for
 * custom models, pi-ai's default support rule).
 */
export type ThinkingLevelMapOverride = Partial<Record<ThinkingLevelId, string | null>>;

/** The three protocols Volto exposes as first-class routes. */
export type ProviderProtocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";

/** `auto` is a config-only value; resolution must produce one concrete protocol. */
export type ConfiguredProtocol = ProviderProtocol | "auto";

export interface ProviderAuth {
  kind: "bearer" | "x-api-key" | "header";
  /** Header name for `kind: "header"`; the value comes from the apiKey. */
  name?: string;
}

const PROVIDER_PROTOCOLS: readonly ProviderProtocol[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
];

export function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return typeof value === "string"
    && (PROVIDER_PROTOCOLS as readonly string[]).includes(value);
}

/**
 * Resolve one model's protocol without side effects.
 *
 * Priority: model override > provider default > catalog api > custom default.
 * `auto` at the provider level means "follow the catalog"; custom providers
 * have no catalog entry, so they fall back to openai-completions.
 */
export function resolveProviderProtocol(
  config: PiAiProviderConfig,
  model: string,
  catalogApi?: string,
): ProviderProtocol | undefined {
  const configured = config.kind === "catalog"
    ? config.modelProtocols?.[model] ?? config.protocol
    : config.models.find((entry) => entry.code === model)?.protocol ?? config.protocol;
  if (configured !== undefined && configured !== "auto") {
    if (!isProviderProtocol(configured)) {
      throw new Error(
        `pi-ai: unknown protocol "${String(configured)}" for provider "${config.id}" model "${model}"`,
      );
    }
    return configured;
  }
  if (catalogApi !== undefined) {
    // Catalog providers outside the three first-class protocols keep their
    // own API (Google, Bedrock, ...). `undefined` means "preserve catalog".
    return isProviderProtocol(catalogApi) ? catalogApi : undefined;
  }
  return "openai-completions";
}

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
      /** Provider-level protocol default; `auto` follows the catalog api. */
      protocol?: ConfiguredProtocol;
      /** Per-model protocol override, winning over `protocol`. */
      modelProtocols?: Record<string, ProviderProtocol>;
      /** How the API key is sent; omitted derives from the protocol. */
      auth?: ProviderAuth;
      /** Extra non-secret request headers. */
      headers?: Record<string, string>;
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
      /**
       * Per-model user override of pi-ai's catalog `thinkingLevelMap`,
       * merged key-by-key over the catalog's own map. Same value semantics
       * as {@link ThinkingLevelMapOverride}.
       */
      thinkingLevelMapOverrides?: Record<string, ThinkingLevelMapOverride>;
    }
  | {
      kind: "custom";
      id: string;
      name?: string;
      baseURL: string;
      apiKey?: string;
      /** Default protocol for every model; omitted means openai-completions. */
      protocol?: ProviderProtocol;
      /** How the API key is sent; omitted derives from the protocol. */
      auth?: ProviderAuth;
      /** Extra non-secret request headers. */
      headers?: Record<string, string>;
      models: Array<{
        code: string;
        name?: string;
        /** Per-model protocol override. */
        protocol?: ProviderProtocol;
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
        /**
         * Per-level thinking API parameter values for a hand-declared
         * gateway model. There is no catalog map to merge with, so this
         * replaces the whole declaration (absent keys fall back to pi-ai's
         * default support rule). Only meaningful with `reasoning: true`.
         */
        thinkingLevelMap?: ThinkingLevelMapOverride;
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
function normalizeBaseUrl(baseUrl: string, protocol: ProviderProtocol): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  // The OpenAI SDK appends /chat/completions (or /responses) after /v1. The
  // Anthropic SDK appends /v1/messages itself, so an Anthropic-compatible
  // gateway must keep its configured path verbatim (e.g. Qwen's
  // /apps/anthropic endpoint).
  if (protocol === "anthropic-messages") return trimmed;
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
 *
 * Registration contract — coupled with {@link levelOverrides}: exactly the
 * custom + synthesized build paths register BOTH maps; the known-catalog
 * path registers only `levelOverrides`. `describeModelInfo` relies on this
 * asymmetry twice — `inputDeclarations.has(model)` as the "no catalog map
 * baseline" discriminator for level value fallback, `levelOverrides.get`
 * for per-level `overridden` — so any new build path must keep the pair in
 * sync (see the comments at each registration site).
 */
const inputDeclarations = new WeakMap<object, ModelInputValue | undefined>();

/**
 * Which thinking levels the USER decided for one exact model — the keys of
 * each registered override map. `describeModelInfo` reads this to fill
 * `ModelThinkingLevelInfo.overridden`: the merged `Model.thinkingLevelMap`
 * alone cannot tell a catalog fact from a user decision. All three config
 * build paths (custom, known-catalog, synthesized) register here; a
 * test-injected model stays unregistered and reports every level as not
 * overridden. Registration contract is coupled with {@link
 * inputDeclarations} — see its doc block for the asymmetry describeModelInfo
 * depends on; keep both maps in sync when adding a build path.
 */
const levelOverrides = new WeakMap<object, ThinkingLevelMapOverride>();

/**
 * Build the pi-ai `Model` for one hand-declared config entry. `reasoning`
 * comes straight from the config flag (default `false`, unchanged from phase
 * two). A custom model has no catalog map to merge with, so an explicit
 * `entry.thinkingLevelMap` replaces the whole declaration; without one it
 * stays unset and `getSupportedThinkingLevels()` yields its default level
 * set (off/minimal/low/medium/high, `xhigh`/`max` excluded), which is the
 * best a generic hand-declared OpenAI-completions gateway can claim without
 * per-model level metadata.
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
  entry: CustomModelEntry,
  protocol: ProviderProtocol,
): Model<ProviderProtocol> {
  const model: Model<ProviderProtocol> = {
    id: entry.code,
    name: entry.name ?? entry.code,
    api: protocol,
    provider: providerId,
    baseUrl: normalizeBaseUrl(providerBaseUrl, protocol),
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
  // A declared map replaces the (absent) catalog baseline wholesale; spread
  // copy so later mutation of the config object cannot leak into the model.
  if (entry.thinkingLevelMap !== undefined) {
    model.thinkingLevelMap = { ...entry.thinkingLevelMap };
  }
  inputDeclarations.set(model, entry.input);
  // Snapshot copy, same reason as the thinkingLevelMap spread above: holding
  // the caller's config object would let a later in-place mutation change the
  // reported `overridden` flags without touching the wire map.
  levelOverrides.set(
    model,
    entry.thinkingLevelMap !== undefined ? { ...entry.thinkingLevelMap } : {},
  );
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
 * apps/gateway/src/wiring.ts). Using a fixed-key auth here — the
 * same helper the custom-provider path uses — makes the no-env-fallback
 * behavior structural rather than dependent on the UI always supplying a key.
 */
/**
 * One catalog model entry the user enabled whose code is not in this build's
 * pi-ai catalog (a newly released model, or a typo). Synthesized only when
 * the user also declared `reasoning: true`, a per-model `input` override or
 * a per-model thinking-level map override — otherwise the code simply is not
 * in the Models collection, same as before.
 *
 * `inputOverride`, when present, is the user's stored input declaration: it
 * lands on the synthesized `Model.input` (so pi-ai's transformMessages honors
 * it on the wire) AND in `inputDeclarations` (so `describeModelInfo` answers
 * it). Absent, both stay as they were before this parameter existed: the
 * declaration map records `undefined` (UNKNOWN) and the template/stub's own
 * `input` stands on the wire.
 *
 * `mapOverride`, when present, is merged over whatever thinking-level map
 * the synthesis baseline provides (the reasoning template's inherited map,
 * or nothing at all for the no-template stub branch) and registered in
 * `levelOverrides` so `describeModelInfo` reports the decided levels.
 * An explicit `false` `reasoningOverride` suppresses the capability even
 * when a stored map or input declaration is what triggered the synthesis:
 * the map stays stored (and registered) but pi-ai ignores it entirely while
 * `reasoning` is false, so the settings switch cannot bounce back on.
 *
 * Template choice:
 * - First reasoning-capable catalog model → inherit its thinkingLevelMap
 *   (real efforts for that provider family).
 * - No reasoning model in the catalog at all → take any catalog model as a
 *   structural template, default `reasoning` to true and drop
 *   `thinkingLevelMap` so `getSupportedThinkingLevels` yields the same
 *   default level set a hand-declared custom model gets
 *   (minimal/low/medium/high), unless the override supplies one to stand in
 *   its place.
 */
function synthesizeUnknownCatalogModel(
  source: Provider,
  code: string,
  piProvider: string,
  baseURL: string | undefined,
  inputOverride: ModelInputValue | undefined,
  mapOverride: ThinkingLevelMapOverride | undefined,
  reasoningOverride: boolean | undefined,
  protocol: ProviderProtocol,
): Model<Api> {
  const catalogModels = source.getModels();
  const reasoningTemplate = catalogModels.find((m) => m.reasoning);
  const structural = reasoningTemplate ?? catalogModels[0];

  if (structural) {
    // Merge over the template's own map when there is a reasoning template.
    // With no reasoning template the structural branch drops the inherited
    // map anyway (default level set), so the baseline there is empty too and
    // the override becomes the whole declaration.
    const thinkingLevelMap = mapOverride !== undefined
      ? { ...(reasoningTemplate?.thinkingLevelMap ?? {}), ...mapOverride }
      : undefined;
    const synthesized = {
      ...structural,
      id: code,
      name: code,
      api: protocol,
      ...(protocol !== structural.api ? { compat: undefined } : {}),
      reasoning: reasoningOverride ?? true,
      // No reasoning template and no override: drop any inherited map so the
      // default level set applies. `undefined` is equivalent to absent for
      // the optional access in getSupportedThinkingLevels. With an override,
      // the merged map replaces the (absent or inherited) baseline.
      ...(reasoningTemplate
        ? thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}
        : { thinkingLevelMap }),
      ...(baseURL ? { baseUrl: baseURL } : {}),
      // Same reasoning as inputDeclarations below: the template's
      // inputLimits are directory facts about the TEMPLATE, not about a
      // code the catalog does not know. Clear them so describeModelInfo's
      // `!== undefined` gate reports absence (spec §4.1 / D5: "absent for
      // custom/synthesized models") instead of fabricating a known fact.
      inputLimits: undefined,
      // User declaration wins; spread copy (core's ModelInputValue is
      // readonly, pi-ai's Model.input is mutable). Without an override the
      // template's inherited `input` stands on the wire while the
      // declaration below keeps describeModelInfo at UNKNOWN.
      ...(inputOverride !== undefined ? { input: [...inputOverride] } : {}),
    } as Model<Api>;
    // Inherited `input` alone is structural, not a statement about this
    // unknown code — leave input UNKNOWN rather than trusting the template,
    // unless the user explicitly declared one (which must stick everywhere).
    inputDeclarations.set(synthesized, inputOverride);
    // Snapshot copy (see buildModel): the override must not stay aliased to
    // the caller's config object.
    levelOverrides.set(
      synthesized,
      mapOverride !== undefined ? { ...mapOverride } : {},
    );
    return synthesized;
  }

  // Empty catalog — degrade to a custom-like OpenAI-completions stub.
  const stub = {
    id: code,
    name: code,
    api: protocol,
    provider: piProvider,
    baseUrl: baseURL ?? source.baseUrl ?? "https://api.openai.com",
    reasoning: reasoningOverride ?? true,
    // Same override semantics as the structural branch above: a stored
    // declaration replaces the stub default, absence keeps UNKNOWN via the
    // declaration map while the wire value stays the stub's `["text"]`.
    input: inputOverride !== undefined ? [...inputOverride] : ["text"],
    // No template exists here, so the stub has no baseline map: the
    // override, when present, is the whole declaration.
    ...(mapOverride !== undefined ? { thinkingLevelMap: { ...mapOverride } } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  } as Model<Api>;
  inputDeclarations.set(stub, inputOverride);
  // Snapshot copy (see buildModel).
  levelOverrides.set(stub, mapOverride !== undefined ? { ...mapOverride } : {});
  return stub;
}

const PROTOCOL_API = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
} as const;

/** One implementation per protocol actually used by this provider. */
function protocolApiMap(models: readonly Model<Api>[]): Partial<Record<ProviderProtocol, ProviderStreams>> {
  const used = new Set(models.map((model) => model.api).filter(isProviderProtocol));
  const out: Partial<Record<ProviderProtocol, ProviderStreams>> = {};
  for (const protocol of used) {
    out[protocol] = PROTOCOL_API[protocol]();
  }
  return out;
}

function buildCatalogProvider(config: CatalogProviderConfig): Provider {
  const source = builtinProviders().find((provider) => provider.id === config.piProvider);
  if (!source) {
    throw new Error(`pi-ai: unknown catalog provider "${config.piProvider}"`);
  }

  const selected = new Set(config.modelCodes);
  const catalogModels = source.getModels();
  const knownIds = new Set(catalogModels.map((m) => m.id));

  const originalApis = new Map(catalogModels.map((model) => [model.id, model.api] as const));
  const models: Model<Api>[] = catalogModels
    .filter((model) => selected.has(model.id))
    .map((model) => {
      // Local so `!== undefined` narrows the possibly-undefined indexed
      // read (noUncheckedIndexedAccess does not narrow element access).
      const inputOverride = config.inputOverrides?.[model.id];
      // Local for the same narrowing reason as inputOverride above.
      const mapOverride = config.thinkingLevelMapOverrides?.[model.id];
      const protocol = resolveProviderProtocol(config, model.id, model.api);
      const mapped: Model<Api> = {
        ...model,
        ...(protocol !== undefined ? { api: protocol } : {}),
        // A protocol override invalidates the catalog model's compat shape:
        // OpenAI compat keys do not describe an Anthropic request. Let pi-ai
        // auto-detect instead of carrying the old dialect's compat across.
        ...(protocol !== undefined && protocol !== model.api
          ? { compat: undefined }
          : model.api === "openai-completions" || model.api === "openai-responses"
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
        // Per-level merge over the catalog's own map: an explicit `null`
        // value in the override still lands (JSON round-trips preserve it),
        // so `{ ...model.thinkingLevelMap, ...mapOverride }` is enough —
        // undefined-valued keys never exist in a parsed override. Absent
        // keys keep the catalog's answer. Spread copy either way.
        ...(mapOverride !== undefined
          ? { thinkingLevelMap: { ...model.thinkingLevelMap, ...mapOverride } }
          : {}),
        ...(config.baseURL ? { baseUrl: config.baseURL } : {}),
      };
      // Register the user's per-level decisions for describeModelInfo's
      // `overridden` flag, keyed on the NEW object the spread above produced
      // — that same object is what `models.getModel` hands back. An empty
      // override map means "the catalog decided everything": every key
      // reads overridden false while the merged map still carries the
      // catalog values; still register it so every config path is treated
      // alike.
      levelOverrides.set(mapped, mapOverride !== undefined ? { ...mapOverride } : {});
      return mapped;
    });

  // Enabled codes the catalog does not know: synthesize an entry when the
  // user declared anything about it (forced reasoning OR a stored input
  // override OR a stored thinking-level map override) so describeModel /
  // effort validation / the input backstop keep working instead of dropping
  // the user's declared intent on the floor.
  for (const code of config.modelCodes) {
    if (knownIds.has(code)) continue;
    const inputOverride = config.inputOverrides?.[code];
    const mapOverride = config.thinkingLevelMapOverrides?.[code];
    if (
      config.reasoningOverrides?.[code] !== true
      && inputOverride === undefined
      && mapOverride === undefined
    ) continue;
    models.push(
      synthesizeUnknownCatalogModel(
        source,
        code,
        config.piProvider,
        config.baseURL,
        inputOverride,
        mapOverride,
        config.reasoningOverrides?.[code],
        resolveProviderProtocol(config, code, source.getModels()[0]?.api) ?? "openai-completions",
      ),
    );
  }

  const apis = protocolApiMap(models);
  // Catalog models outside the three first-class protocols keep the catalog
  // provider's own implementation; supported models dispatch through the
  // selected API implementation. A manual Provider keeps that fallback
  // available (createProvider's API map has no per-model fallback).
  const dispatch = <T>(model: Model<Api>, run: (streams: ProviderStreams) => T, fallback: () => T): T => {
    // Untouched catalog models keep the built-in provider wrapper (opencode's
    // session header, cloudflare's URL placeholders, …). Only a model whose
    // protocol was actually overridden needs a different API implementation.
    if (originalApis.get(model.id) === model.api) return fallback();
    const streams = apis[model.api as ProviderProtocol];
    return streams !== undefined ? run(streams) : fallback();
  };
  return {
    id: config.piProvider,
    name: source.name,
    baseUrl: config.baseURL ?? source.baseUrl,
    auth: { apiKey: fixedApiKeyAuth(config.id, config.apiKey) },
    getModels: () => models,
    stream: (model, context, options) =>
      dispatch(model, (streams) => streams.stream(model, context, options), () => source.stream(model, context, options)),
    streamSimple: (model, context, options) =>
      dispatch(
        model,
        (streams) => streams.streamSimple(model, context, options),
        () => source.streamSimple(model, context, options),
      ),
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
  for (const provider of providers) {
    if (provider.kind === "catalog") {
      if (provider.protocol !== undefined && provider.protocol !== "auto"
        && !isProviderProtocol(provider.protocol)) {
        throw new Error(`pi-ai: unknown protocol "${String(provider.protocol)}" for provider "${provider.id}"`);
      }
      for (const code of provider.modelCodes) {
        resolveProviderProtocol(provider, code);
      }
    } else {
      if (provider.protocol !== undefined && !isProviderProtocol(provider.protocol)) {
        throw new Error(`pi-ai: unknown protocol "${String(provider.protocol)}" for provider "${provider.id}"`);
      }
      for (const model of provider.models) {
        resolveProviderProtocol(provider, model.code);
      }
    }
  }
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

    const builtModels = config.models.map((entry) =>
      buildModel(
        config.id,
        config.baseURL,
        entry,
        resolveProviderProtocol(config, entry.code) ?? "openai-completions",
      ),
    );
    const apis = protocolApiMap(builtModels);
    // An empty custom provider is valid while the user is still adding
    // models; pi-ai still requires one API implementation at construction.
    if (Object.keys(apis).length === 0) apis["openai-completions"] = openAICompletionsApi();
    const provider = createProvider({
      id: config.id,
      name: config.name,
      baseUrl: config.baseURL,
      auth: { apiKey: fixedApiKeyAuth(config.id, config.apiKey) },
      models: builtModels,
      api: apis,
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

/** Cache support implied by the wire protocol and pi-ai's promptCache metadata. */
export function cacheCapability(model: Model<Api>): ModelCacheCapability {
  if (model.api === "anthropic-messages") {
    return {
      mode: "explicit",
      minTokens: 1024,
      maxMarkers: 4,
      blockWindow: 20,
      ...(model.promptCache?.short !== undefined ? { ttlSeconds: model.promptCache.short } : {}),
      writeUsageField: "cache_creation_input_tokens",
    };
  }
  if (model.api === "openai-completions" || model.api === "openai-responses") {
    return {
      mode: "implicit",
      ...(model.promptCache?.short !== undefined ? { minTokens: 1024 } : {}),
    };
  }
  return { mode: "none" };
}

/**
 * Resolve capability metadata for one exact model. `reasoning` is present
 * only when the model is flagged `reasoning: true` and
 * `getSupportedThinkingLevels()` yields at least one non-"off" level; never a
 * synthesized off-only list (an off-only control would be byte-identical to
 * omitting the option entirely).
 *
 * `reasoning.levels` reports all seven thinking levels in THINKING_LEVELS
 * order whenever a reasoning block exists, so the settings editor can show
 * each level's effective value and who decided it.
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
    api: model.api,
    cache: cacheCapability(model),
    contextWindow: model.contextWindow,
  };

  if (model.reasoning) {
    const supportedLevels = getSupportedThinkingLevels(model);
    // pi-ai's per-request fallback (`model.thinkingLevelMap?.[level] ??
    // level`, e.g. dist/api/openai-completions.js:621): a level with no map
    // entry is sent on the wire as its id. Reported values follow the same
    // rule. `off` differs: every dialect treats an absent or null `off` as
    // "no reasoning parameter at all" (openai-completions.js:647+), so it
    // only gets a reported value when the map explicitly maps it to one.
    const mergedMap = model.thinkingLevelMap;
    // Whether this model's map is a full declaration rather than a catalog
    // baseline: custom and synthesized models never inherit a provider's own
    // map wholesale, so an unmapped level falls back to pi-ai's wire rule —
    // the level id itself. Catalog models (even with a merged override) keep
    // the catalog's answer: a level absent from the map has no reported
    // value. The discriminator is the inputDeclarations registration, which
    // marks EXACTLY the custom + synthesized paths — the known-catalog path
    // deliberately does not register there, so switching this to
    // levelOverrides.has() would misreport id-fallback values for unmapped
    // levels of overridden catalog models. See the coupled registration
    // contracts on inputDeclarations/levelOverrides.
    const customBaseline = inputDeclarations.has(model);
    // The id fallback is only truthful for the OpenAI-style dialects, whose
    // wire code is `map[level] ?? level` (openai-completions.js:621,
    // openai-responses.js:88). pi-ai's Anthropic path is the exception:
    // anthropic-messages.js:716-730 maps `minimal` AND `low` to `"low"`
    // (`medium`/`high` to themselves, anything else to `"high"`), so
    // reporting the level id there would promise a value the dialect never
    // sends. An explicit map value still wins on every dialect, including
    // Anthropic, because pi-ai reads the map first.
    const openAiStyleDialect =
      model.api === "openai-completions" || model.api === "openai-responses";
    // Seam shared with inputDeclarations: every config-built model registers
    // its user-decided keys here so `overridden` can be answered per level.
    // Catalog and test-injected models are unregistered — without an
    // override source every level reads overridden: false.
    const declared = levelOverrides.get(model);
    const levels: ModelThinkingLevelInfo[] = THINKING_LEVELS.map((id) => {
      const mapped = mergedMap?.[id];
      // The id fallback is only meaningful for a level pi-ai can actually
      // send: an UNSUPPORTED level never reaches the wire (its map value is
      // null or, for xhigh/max, absent), so reporting one would fabricate a
      // parameter that does not exist. An explicitly string-mapped level is
      // reported even when unsupported — it documents what the map says.
      const value = typeof mapped === "string"
        ? mapped
        : customBaseline
          && openAiStyleDialect
          && id !== "off"
          && supportedLevels.includes(id as ModelThinkingLevel)
            ? id
            : undefined;
      return {
        id: id as ReasoningEffortId, // branded type: same verbatim publication as efforts below
        supported: supportedLevels.includes(id as ModelThinkingLevel),
        ...(value !== undefined ? { value } : {}),
        overridden: declared?.[id] !== undefined,
      };
    });

    const efforts = supportedLevels.filter((level) => level !== "off");
    if (efforts.length > 0) {
      const reasoning: ModelReasoningInfo = {
        efforts: efforts.map((level) => ({
          id: level as ReasoningEffortId, // branded type: effort id is published verbatim from pi-ai; core never interprets it
          name: displayName(level),
        })),
        levels,
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
  }
  // Directory fact, read-only (D5): custom/synthesized models have none.
  if (model.inputLimits !== undefined) {
    info.inputLimits = model.inputLimits;
  }

  return info;
}
