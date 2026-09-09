/**
 * Thin fetch wrappers over the gateway's configuration endpoints.
 *
 * Credentials never travel back from the server: providers carry only a
 * masked key for display. A plaintext apiKey flows one way, in request bodies.
 */

import { SERVER_URL } from './agent-config';

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

/** One selectable reasoning-effort tier for a model. The id is opaque — never hardcode or parse it. */
export interface ReasoningEffort {
  id: string;
  name: string;
  description?: string;
}

export interface Model {
  id: string;
  name: string;
  code: string;
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
  };
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
  /**
   * Overrides of what pi-ai's catalog reports for this model. Absent means
   * "use the catalog's value", so these are only ever written by the user.
   */
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /**
   * Present only when the model declares reasoning-effort tiers, same
   * contract as `Model['reasoning']`. Read-only: reasoning capability comes
   * from pi-ai, never from a stored flag on a catalog model.
   */
  reasoning?: NonNullable<Model['reasoning']>;
}

/** One catalog-provider model entry, as sent in a create/update request body. */
export interface CatalogModelInput {
  code: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
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
      apiKeyMasked: string | null;
      models: CatalogProviderModel[];
    }
  | {
      kind: 'custom';
      id: string;
      name: string;
      baseURL: string | null;
      apiKeyMasked: string | null;
      models: Model[];
    };

/** One custom-provider model entry, as sent in a create/update request body. */
export interface CustomModelInput {
  id?: string;
  name: string;
  code: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Whether this model supports reasoning/thinking. */
  reasoning?: boolean;
}

export type ProviderInput =
  | {
      kind: 'catalog';
      name: string;
      piProvider: string;
      /** Omit to keep the stored key unchanged. */
      apiKey?: string | null;
      models: CatalogModelInput[];
    }
  | {
      kind?: 'custom';
      name: string;
      baseURL?: string | null;
      /** Omit to keep the stored key unchanged. */
      apiKey?: string | null;
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
 * which is server-generated English and not meant to be parsed.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${SERVER_URL}${path}`, {
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
}

export interface CatalogProvider {
  id: string;
  name: string;
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

export const deleteProvider = (id: string) =>
  request<void>(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });

/**
 * Ask the gateway to open a native directory dialog on the machine it runs on.
 * A null path means the user cancelled — that is not an error.
 */
export const pickDirectory = () =>
  request<{ path: string | null }>('/fs/pick-directory', { method: 'POST' });
