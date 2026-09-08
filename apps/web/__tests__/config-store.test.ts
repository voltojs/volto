/**
 * Config store tests. The store mirrors server-side resources, so every test
 * stubs fetch rather than talking to a real gateway.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useConfigStore } from '../stores/config-store.js';

const PROJECT = { id: 'p1', name: 'demo', path: '/tmp/demo', createdAt: 1 };
const PROVIDER = {
  id: 'v1',
  name: 'MiMo',
  baseURL: 'https://example.com/v1',
  apiKeyMasked: 'sk-…3f2a',
  models: [
    { id: 'm1', name: 'MiMo-V2.5-Pro', code: 'mimo-v2.5' },
    {
      id: 'm2',
      name: 'MiMo-Thinking',
      code: 'mimo-thinking',
      reasoning: {
        efforts: [
          { id: 'eff-low', name: 'Low' },
          { id: 'eff-high', name: 'High' },
        ],
        defaultEffort: 'eff-low',
      },
    },
  ],
};

function stubFetch(routes: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    async (input: string | URL, init?: { method?: string }) => {
      const url = String(input);
      const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
      const body = routes[key];
      if (body === undefined) throw new Error(`Unstubbed route: ${key}`);
      return { ok: true, json: async () => body } as Response;
    },
  );
}

beforeEach(() => {
  useConfigStore.setState({
    projects: [],
    providers: [],
    loaded: false,
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useConfigStore', () => {
  it('loads projects and providers', async () => {
    stubFetch({ 'GET /projects': [PROJECT], 'GET /providers': [PROVIDER] });

    await useConfigStore.getState().load();

    const state = useConfigStore.getState();
    expect(state.projects).toEqual([PROJECT]);
    expect(state.providers).toEqual([PROVIDER]);
    expect(state.loaded).toBe(true);
    expect(state.error).toBeNull();
  });

  it('records an error when loading fails', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('connection refused');
    });

    await useConfigStore.getState().load();

    expect(useConfigStore.getState().error).toContain('connection refused');
    expect(useConfigStore.getState().loaded).toBe(false);
  });

  it('finds a model by provider and model id', () => {
    useConfigStore.setState({ providers: [PROVIDER] });
    expect(useConfigStore.getState().findModel('v1', 'm1')?.name).toBe(
      'MiMo-V2.5-Pro',
    );
    expect(useConfigStore.getState().findModel('v1', 'missing')).toBeNull();
    expect(useConfigStore.getState().findModel('missing', 'm1')).toBeNull();
  });

  it('reports validity of a project and a model reference', () => {
    useConfigStore.setState({ projects: [PROJECT], providers: [PROVIDER] });
    const state = useConfigStore.getState();
    expect(state.isProjectValid('p1')).toBe(true);
    expect(state.isProjectValid('gone')).toBe(false);
    expect(state.isModelValid('v1', 'm1')).toBe(true);
    expect(state.isModelValid('v1', 'gone')).toBe(false);
  });

  it('appends a created project to local state and returns it', async () => {
    stubFetch({ 'POST /projects': PROJECT });
    const created = await useConfigStore
      .getState()
      .addProject({ name: 'demo', path: '/tmp/demo' });
    expect(useConfigStore.getState().projects).toEqual([PROJECT]);
    expect(created).toEqual(PROJECT);
  });

  it('returns null reasoning for a model with no reasoning capability', () => {
    useConfigStore.setState({ providers: [PROVIDER] });
    expect(
      useConfigStore.getState().getModelReasoning('v1', 'm1'),
    ).toBeNull();
  });

  it('returns the declared efforts for a model with reasoning capability', () => {
    useConfigStore.setState({ providers: [PROVIDER] });
    const reasoning = useConfigStore.getState().getModelReasoning('v1', 'm2');
    expect(reasoning).toEqual({
      efforts: [
        { id: 'eff-low', name: 'Low' },
        { id: 'eff-high', name: 'High' },
      ],
      defaultEffort: 'eff-low',
    });
  });

  it('returns null reasoning for an unknown provider or model', () => {
    useConfigStore.setState({ providers: [PROVIDER] });
    expect(useConfigStore.getState().getModelReasoning('gone', 'm1')).toBeNull();
    expect(useConfigStore.getState().getModelReasoning('v1', 'gone')).toBeNull();
  });

  it('drops a removed provider from local state', async () => {
    useConfigStore.setState({ providers: [PROVIDER] });
    stubFetch({ 'DELETE /providers/v1': { removed: true } });
    await useConfigStore.getState().removeProvider('v1');
    expect(useConfigStore.getState().providers).toEqual([]);
  });
});
