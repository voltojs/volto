import { create } from 'zustand';
import * as api from '@/lib/config-api';
import type {
  Project,
  Provider,
  Model,
  ProviderInput,
  ProviderUpdateInput,
  CatalogProvider,
} from '@/lib/config-api';

export type {
  Project,
  Provider,
  Model,
  ProviderInput,
  ProviderUpdateInput,
  CatalogProvider,
};

/**
 * Normalizes a provider's model list to `Model[]` regardless of `kind`.
 *
 * A catalog provider's `GET /providers` models carry no `id`/`name` (see
 * `CatalogProviderModel`) since selection is by pi-ai code, not a
 * server-assigned id — the display `name` is looked up from the pi-ai
 * catalog (`GET /catalog/providers`) by matching `code`. When the catalog
 * hasn't loaded yet, or no longer lists that code (e.g. a stale
 * `piProvider`/`modelCodes` pair after a pi-ai upgrade), fall back to the
 * code itself so callers ("the models under this provider, with an id and
 * a name" — pickers, validity checks) never see a missing name.
 */
/**
 * Identity cache for the catalog branch below.
 *
 * That branch builds fresh `Model` objects on every call, which makes it
 * unusable inside a zustand selector: `useConfigStore((s) => s.findModel(...))`
 * compares snapshots by reference, so a new object each render is an
 * "infinite loop" warning and a re-render storm. Keyed by the provider object
 * so a `set()` that replaces the provider (the only way its models can change)
 * naturally misses the cache; the catalog list is stored alongside so a later
 * catalog load — which changes display names — misses it too.
 */
const catalogModelsCache = new WeakMap<
  object,
  WeakMap<object, Model[]>
>();

/**
 * Shared default for the parameter below — a fresh `[]` literal would be a new
 * reference on every call and would thrash `catalogModelsCache` between the
 * callers that pass a catalog and those that don't.
 */
const NO_CATALOG: CatalogProvider[] = [];

export function providerModels(
  provider: Provider,
  catalogProviders: readonly CatalogProvider[] = NO_CATALOG,
): Model[] {
  if (provider.kind === 'catalog') {
    // Keyed by both, so a caller that passes no catalog cannot evict the
    // entry a selector depends on (and vice versa) — an alternating
    // single-slot cache would still hand out a new array every render.
    const byCatalog = catalogModelsCache.get(provider);
    const cached = byCatalog?.get(catalogProviders);
    if (cached) return cached;
    const catalogEntry = catalogProviders.find(
      (c) => c.id === provider.piProvider,
    );
    const models = provider.models.map((m) => {
      const catalogModel = catalogEntry?.models.find((cm) => cm.code === m.code);
      const contextWindow = m.contextWindow ?? catalogModel?.contextWindow;
      const maxOutputTokens =
        m.maxOutputTokens ?? catalogModel?.maxOutputTokens;
      return {
        id: m.code,
        // The user's own override wins, then pi-ai's catalog name, then the
        // raw code — never a missing name.
        name: m.name ?? catalogModel?.name ?? m.code,
        code: m.code,
        // Effective value = the user's override, else pi-ai's catalog. The
        // gateway deliberately reports only the override (see server.ts's
        // withReasoningCapability), so this merge happens exactly here — and
        // the settings form, which edits the override, must NOT use it.
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...(m.reasoning ? { reasoning: m.reasoning } : {}),
        // Three-state: absent stays absent, so the composer can tell
        // "text-only" from "the gateway never said".
        ...(m.input === undefined ? {} : { input: m.input }),
      };
    });
    const slot = byCatalog ?? new WeakMap<object, Model[]>();
    slot.set(catalogProviders, models);
    if (!byCatalog) catalogModelsCache.set(provider, slot);
    return models;
  }
  return provider.models;
}

/**
 * Mirror of the gateway's configuration. Deliberately NOT persisted: the
 * server is the source of truth, and a stale local copy would let the UI
 * offer projects or models that no longer exist.
 */
interface ConfigState {
  projects: Project[];
  providers: Provider[];
  /**
   * pi-ai's built-in provider/model catalog, used to resolve a catalog
   * model's display name from its `code` (see `providerModels`). Loaded
   * best-effort alongside providers/projects — a failure here must not
   * block the rest of config from loading, since `providerModels` already
   * falls back to the raw code when this is empty or stale.
   */
  catalogProviders: CatalogProvider[];
  loaded: boolean;
  error: string | null;

  load: () => Promise<void>;
  /** Returns the created project so callers can select it immediately. */
  addProject: (input: { name: string; path: string }) => Promise<Project>;
  removeProject: (id: string) => Promise<void>;
  /** Returns the created provider so callers can open it for editing immediately. */
  addProvider: (input: ProviderInput) => Promise<Provider>;
  editProvider: (id: string, input: ProviderUpdateInput) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;

  findModel: (
    providerId: string | null,
    modelId: string | null,
  ) => Model | null;
  isProjectValid: (id: string | null) => boolean;
  isModelValid: (providerId: string | null, modelId: string | null) => boolean;
  /** Null for an unknown model reference or a model with no reasoning capability. */
  getModelReasoning: (
    providerId: string | null,
    modelId: string | null,
  ) => Model['reasoning'] | null;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  projects: [],
  providers: [],
  catalogProviders: [],
  loaded: false,
  error: null,

  load: async () => {
    try {
      const [projects, providers, catalogProviders] = await Promise.all([
        api.fetchProjects(),
        api.fetchProviders(),
        // Best-effort: an unreachable catalog shouldn't block config from
        // loading, it only means catalog model names fall back to codes.
        api.fetchCatalogProviders().catch(() => get().catalogProviders),
      ]);
      set({ projects, providers, catalogProviders, loaded: true, error: null });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        loaded: false,
      });
    }
  },

  addProject: async (input) => {
    const project = await api.createProject(input);
    set((state) => ({ projects: [...state.projects, project] }));
    return project;
  },

  removeProject: async (id) => {
    await api.deleteProject(id);
    set((state) => ({ projects: state.projects.filter((p) => p.id !== id) }));
  },

  addProvider: async (input) => {
    const provider = await api.createProvider(input);
    set((state) => ({ providers: [...state.providers, provider] }));
    return provider;
  },

  editProvider: async (id, input) => {
    const provider = await api.updateProvider(id, input);
    set((state) => ({
      providers: state.providers.map((p) => (p.id === id ? provider : p)),
    }));
  },

  removeProvider: async (id) => {
    await api.deleteProvider(id);
    set((state) => ({ providers: state.providers.filter((p) => p.id !== id) }));
  },

  findModel: (providerId, modelId) => {
    if (!providerId || !modelId) return null;
    const provider = get().providers.find((p) => p.id === providerId);
    if (!provider) return null;
    return (
      providerModels(provider, get().catalogProviders).find(
        (m) => m.id === modelId,
      ) ?? null
    );
  },

  isProjectValid: (id) =>
    id ? get().projects.some((p) => p.id === id) : false,

  isModelValid: (providerId, modelId) =>
    get().findModel(providerId, modelId) !== null,

  getModelReasoning: (providerId, modelId) =>
    get().findModel(providerId, modelId)?.reasoning ?? null,
}));
