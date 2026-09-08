import { create } from 'zustand';
import * as api from '@/lib/config-api';
import type {
  Project,
  Provider,
  Model,
  ProviderInput,
  ProviderUpdateInput,
} from '@/lib/config-api';

export type { Project, Provider, Model, ProviderInput, ProviderUpdateInput };

/**
 * Normalizes a provider's model list to `Model[]` regardless of `kind`.
 *
 * A catalog provider's `GET /providers` models carry no `id`/`name` (see
 * `CatalogProviderModel`) since selection is by pi-ai code, not a
 * server-assigned id — this synthesizes both from the code so every caller
 * that just wants "the models under this provider, with an id and a name"
 * (pickers, validity checks) can treat both kinds the same way.
 */
export function providerModels(provider: Provider): Model[] {
  if (provider.kind === 'catalog') {
    return provider.models.map((m) => ({
      id: m.code,
      name: m.code,
      code: m.code,
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    }));
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
  loaded: boolean;
  error: string | null;

  load: () => Promise<void>;
  /** Returns the created project so callers can select it immediately. */
  addProject: (input: { name: string; path: string }) => Promise<Project>;
  removeProject: (id: string) => Promise<void>;
  addProvider: (input: ProviderInput) => Promise<void>;
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
  loaded: false,
  error: null,

  load: async () => {
    try {
      const [projects, providers] = await Promise.all([
        api.fetchProjects(),
        api.fetchProviders(),
      ]);
      set({ projects, providers, loaded: true, error: null });
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
    return providerModels(provider).find((m) => m.id === modelId) ?? null;
  },

  isProjectValid: (id) =>
    id ? get().projects.some((p) => p.id === id) : false,

  isModelValid: (providerId, modelId) =>
    get().findModel(providerId, modelId) !== null,

  getModelReasoning: (providerId, modelId) =>
    get().findModel(providerId, modelId)?.reasoning ?? null,
}));
