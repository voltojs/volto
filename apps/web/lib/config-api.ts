/**
 * Thin fetch wrappers over the gateway's configuration endpoints.
 *
 * Credentials never travel back from the server: providers carry only a
 * masked key for display. A plaintext apiKey flows one way, in request bodies.
 */

import { gatewayUrl } from './gateway-base';

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

export type ProviderProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages';

export type ProviderAuth =
  | { kind: 'bearer' }
  | { kind: 'x-api-key' }
  | { kind: 'header'; name: string };

/** One selectable reasoning-effort tier for a model. The id is opaque — never hardcode or parse it. */
export interface ReasoningEffort {
  id: string;
  name: string;
  description?: string;
}

/** Input modalities a model accepts (wire shape of core's ModelInputValue). */
export type ModelInputValue = ('text' | 'image')[];

/**
 * The seven thinking levels in display order — mirror of the gateway's
 * `THINKING_LEVELS` (packages/providers pi-ai collection), which mirrors
 * pi-ai's extended set including `"off"`.
 */
export type ThinkingLevelId =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

/**
 * Per-level override of a model's thinking mapping, as stored and exchanged
 * with the gateway (`GET /providers` model records and `ProviderInput` model
 * entries). A string marks the level supported and sent on the wire as that
 * value; null marks it unsupported; an absent key inherits the catalog. An
 * absent field or `{}` both mean "no override".
 */
export type ThinkingLevelMap = Partial<Record<ThinkingLevelId, string | null>>;

/**
 * One resolved thinking level as `GET /providers` reports it inside
 * `reasoning.levels`: all seven levels in display order, each saying whether
 * it is usable, its effective wire value (absent when the dialect omits it),
 * and whether a user override decided it. Read-only display truth — never
 * written back by the settings forms.
 */
export interface ThinkingLevelInfo {
  id: string;
  supported: boolean;
  value?: string;
  overridden: boolean;
}

/** Provider input limits, read-only directory fact (wire shape of core's ModelInputLimits). */
export interface ModelInputLimits {
  maxRequestBytes?: number;
  images?: {
    resize?: {
      maxWidth?: number;
      maxHeight?: number;
      maxBytes?: number;
      jpegQuality?: number;
    };
    maxPerMessage?: number;
    maxPerRequest?: number;
  };
}

export interface Model {
  id: string;
  name: string;
  code: string;
  /** Per-model protocol override; absent follows the provider default. */
  protocol?: ProviderProtocol;
  /** 最大上下文窗口（tokens）。可选：未设置时上下文环显示灰态。 */
  contextWindow?: number;
  /** 单次模型调用的最大输出 token 数。可选：未设置时沿用供应商默认值。 */
  maxOutputTokens?: number;
  /**
   * Present only when the model declares reasoning-effort tiers. Absent —
   * never an empty `efforts` list — for a model with no such capability;
   * callers must check for the key rather than the list length.
   */
  reasoning?: {
    efforts: ReasoningEffort[];
    defaultEffort?: string;
    /** Resolved thinking levels, same contract as `CatalogProviderModel['reasoning']`. */
    levels?: ThinkingLevelInfo[];
  };
  /**
   * Input modalities, three-state. Absent means UNKNOWN (a gateway that
   * cannot describe its models), which must behave like image-capable
   * here: only an explicit `["text"]` gates the composer's attachment
   * entry off (spec D2 — vision retired into this single source).
   */
  input?: ModelInputValue;
  /**
   * Stored per-level thinking override map, the draft seed the settings
   * form edits and sends back verbatim (wire source: `GET /providers`
   * custom model records; accepted again on `POST/PUT /providers`).
   * Absent or `{}` means "no override".
   */
  thinkingLevelMap?: ThinkingLevelMap;
}

/**
 * A model entry inside a catalog-kind provider's `GET /providers` response.
 * Unlike a custom provider's `Model`, there is no server-assigned `id` or
 * display `name` here — the model is identified by `code`, and its display
 * name must be looked up from `/catalog/providers` by matching `code`. This
 * mirrors `withReasoningCapability`'s catalog projection in the gateway.
 */
export interface CatalogProviderModel {
  code: string;
  /** Per-model protocol override; absent follows the provider default. */
  protocol?: ProviderProtocol;
  /**
   * Overrides of what pi-ai's catalog reports for this model. Absent means
   * "use the catalog's value", so these are only ever written by the user.
   */
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /**
   * Present only when the model declares reasoning-effort tiers, same
   * contract as `Model['reasoning']`. Derived from pi-ai's catalog, possibly
   * suppressed by a stored per-model override (see `CatalogModelInput.reasoning`).
   */
  reasoning?: NonNullable<Model['reasoning']>;
  /** Input modalities, same three-state contract as `Model['input']`. */
  input?: ModelInputValue;
  /**
   * Read-only directory limits resolved alongside `input` by `GET /providers`
   * (absent when the gateway cannot resolve the model) — display seed only,
   * never written back by the settings forms.
   */
  inputLimits?: ModelInputLimits;
  /**
   * Stored per-level thinking override map (the draft seed the settings form
   * edits), same contract as `Model['thinkingLevelMap']`. The resolved truth
   * for display arrives separately as `reasoning.levels`.
   */
  thinkingLevelMap?: ThinkingLevelMap;
}

/** One catalog-provider model entry, as sent in a create/update request body. */
export interface CatalogModelInput {
  code: string;
  protocol?: ProviderProtocol;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /**
   * User override of pi-ai's catalog reasoning flag. `false` forces the model
   * non-reasoning; `true` keeps/forces reasoning (efforts still come from
   * pi-ai when it declares them). Always sent by the settings form.
   */
  reasoning?: boolean;
  /** Per-model input override/declaration; omitted = follow catalog / UNKNOWN. */
  input?: ModelInputValue;
  /**
   * Per-level thinking override map to store; mirrors the draft verbatim.
   * Omitted or `{}` means "no override" — the settings form drops an empty
   * map rather than sending it, so a toggled-off editor never persists `{}`.
   */
  thinkingLevelMap?: ThinkingLevelMap;
}

/**
 * `kind` discriminates a catalog provider (backed by pi-ai's built-in
 * provider registry, selecting models by code from `/catalog/providers`)
 * from a custom one (a hand-declared OpenAI-completions-compatible endpoint
 * with its own model list). `kind` is immutable after creation — the
 * gateway rejects an update that tries to change it; the UI must not offer
 * converting one into the other.
 */
export type Provider =
  | {
      kind: 'catalog';
      id: string;
      name: string;
      piProvider: string;
      /** Replaces pi-ai's own address for this provider; null means "use it". */
      baseURL: string | null;
      apiKeyMasked: string | null;
      protocol?: 'auto' | ProviderProtocol;
      auth?: ProviderAuth;
      models: CatalogProviderModel[];
    }
  | {
      kind: 'custom';
      id: string;
      name: string;
      baseURL: string | null;
      apiKeyMasked: string | null;
      protocol?: ProviderProtocol;
      auth?: ProviderAuth;
      models: Model[];
    };

/** One custom-provider model entry, as sent in a create/update request body. */
export interface CustomModelInput {
  id?: string;
  name: string;
  code: string;
  protocol?: ProviderProtocol;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Whether this model supports reasoning/thinking. */
  reasoning?: boolean;
  /** Per-model input override/declaration; omitted = follow catalog / UNKNOWN. */
  input?: ModelInputValue;
  /**
   * Per-level thinking override map to store; same contract and empty-map
   * ruling as `CatalogModelInput.thinkingLevelMap`.
   */
  thinkingLevelMap?: ThinkingLevelMap;
}

export type ProviderInput =
  | {
      kind: 'catalog';
      name: string;
      piProvider: string;
      /** Null clears the override; omitted leaves it unchanged. */
      baseURL?: string | null;
      /** Omit to keep the stored key unchanged. */
      apiKey?: string | null;
      protocol?: 'auto' | ProviderProtocol;
      auth?: ProviderAuth | null;
      models: CatalogModelInput[];
    }
  | {
      kind?: 'custom';
      name: string;
      baseURL?: string | null;
      /** Omit to keep the stored key unchanged. */
      apiKey?: string | null;
      protocol?: ProviderProtocol;
      auth?: ProviderAuth | null;
      models?: CustomModelInput[];
    };

/**
 * Partial update bodies, kept as a union of per-kind partials rather than
 * `Partial<ProviderInput>` — `Partial` over a union only keeps the keys
 * shared by every member (here, just `kind`), which would silently drop
 * `piProvider` / `baseURL` / `models` from the callable type.
 */
export type ProviderUpdateInput =
  | ({ kind?: 'catalog' } & Partial<
      Omit<Extract<ProviderInput, { kind: 'catalog' }>, 'kind'>
    >)
  | ({ kind?: 'custom' } & Partial<
      Omit<Extract<ProviderInput, { kind?: 'custom' }>, 'kind'>
    >);

/**
 * An error response from the gateway. Carries the HTTP status so callers can
 * branch on specific conditions (e.g. 409) without matching on message text,
 * which is server-generated English and not meant to be parsed. Structured
 * error details travel on `body` for the same reason.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The parsed error body the gateway sent, when there was one. */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(gatewayUrl(path), {
    // Cookie auth (Route P): the gateway rejects unauthenticated calls.
    credentials: 'include',
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new ApiError(
      detail?.error ?? `Request failed with HTTP ${response.status}`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

export const fetchProjects = () => request<Project[]>('/projects');

export const createProject = (input: { name: string; path: string }) =>
  request<Project>('/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const deleteProject = (id: string) =>
  request<void>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const fetchProviders = () => request<Provider[]>('/providers');

/** A single model surfaced from pi-ai's built-in catalog (settings' add-provider flow). */
export interface CatalogModel {
  code: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  input?: ModelInputValue;
  inputLimits?: ModelInputLimits;
}

export interface CatalogProvider {
  id: string;
  name: string;
  /** The provider's own address, shown as the default an override replaces. */
  baseUrl?: string;
  models: CatalogModel[];
}

/** Providers the user can authenticate with a typed API key, from pi-ai's static catalog. */
export const fetchCatalogProviders = () =>
  request<CatalogProvider[]>('/catalog/providers');

export const createProvider = (input: ProviderInput) =>
  request<Provider>('/providers', {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const updateProvider = (id: string, input: ProviderUpdateInput) =>
  request<Provider>(`/providers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });

export interface ProviderProbeResult {
  live: false;
  ok: boolean;
  protocol?: string;
  cache: 'none' | 'implicit' | 'explicit' | 'unknown';
  checks: { model: boolean; auth: boolean; protocol: boolean };
  error?: string;
}

export const probeProvider = (
  id: string,
  input: { modelId?: string; protocol?: ProviderProtocol } = {},
) =>
  request<ProviderProbeResult>(`/providers/${encodeURIComponent(id)}/probe`, {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const deleteProvider = (id: string) =>
  request<void>(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });

/**
 * Ask the gateway to open a native directory dialog on the machine it runs on.
 * A null path means the user cancelled — that is not an error.
 */
export const pickDirectory = () =>
  request<{ path: string | null }>('/fs/pick-directory', { method: 'POST' });

/**
 * Ask the gateway to reveal an absolute path in the OS file manager
 * (Finder / Explorer / xdg-open). Runs on the gateway's machine.
 */
export const revealPath = (path: string) =>
  request<{ ok: true }>('/fs/reveal', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });

/** One browser installed on the gateway host, as shown in 设置 → 工具配置. */
export interface BrowserCandidate {
  id: string;
  label: string;
  path: string;
}

/** `GET /config/browser`: the gateway OS, stored path, and detected browsers. */
export interface BrowserSettingsView {
  platform: string;
  configuredPath: string | null;
  resolvedPath: string | null;
  browsers: BrowserCandidate[];
}

export const fetchBrowserSettings = () =>
  request<BrowserSettingsView>('/config/browser');

/** Persist the selection in config.json; null clears it (auto-detect). */
export const updateBrowserSettings = (executablePath: string | null) =>
  request<BrowserSettingsView>('/config/browser', {
    method: 'PUT',
    body: JSON.stringify({ executablePath }),
  });
