import { create } from 'zustand';
import * as api from '@/lib/config-api';
import type { Project, Provider, Model, ProviderInput } from '@/lib/config-api';

export type { Project, Provider, Model };

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
  editProvider: (id: string, input: Partial<ProviderInput>) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;

  findModel: (
    providerId: string | null,
    modelId: string | null,
  ) => Model | null;
  isProjectValid: (id: string | null) => boolean;
  isModelValid: (providerId: string | null, modelId: string | null) => boolean;
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
    return provider?.models.find((m) => m.id === modelId) ?? null;
  },

  isProjectValid: (id) =>
    id ? get().projects.some((p) => p.id === id) : false,

  isModelValid: (providerId, modelId) =>
    get().findModel(providerId, modelId) !== null,
}));
