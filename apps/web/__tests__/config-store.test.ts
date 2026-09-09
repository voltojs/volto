/**
 * Config store tests. The store mirrors server-side resources, so every test
 * stubs fetch rather than talking to a real gateway.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useConfigStore, providerModels } from '../stores/config-store.js';

const PROJECT = { id: 'p1', name: 'demo', path: '/tmp/demo', createdAt: 1 };
const PROVIDER = {
  id: 'v1',
  kind: 'custom' as const,
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
    catalogProviders: [],
    loaded: false,
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useConfigStore', () => {
  it('loads projects, providers and the catalog', async () => {
    stubFetch({
      'GET /projects': [PROJECT],
      'GET /providers': [PROVIDER],
      'GET /catalog/providers': [],
    });

    await useConfigStore.getState().load();

    const state = useConfigStore.getState();
    expect(state.projects).toEqual([PROJECT]);
    expect(state.providers).toEqual([PROVIDER]);
    expect(state.catalogProviders).toEqual([]);
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

  it('returns the reasoning object even when it declares zero effort tiers', () => {
    // A truthy `reasoning` with an empty `efforts` array is still a declared
    // capability and must be returned as-is, not nulled out like a missing key.
    const providerWithEmptyEfforts = {
      ...PROVIDER,
      id: 'v3',
      models: [
        {
          id: 'm3',
          name: 'MiMo-Bare-Reasoning',
          code: 'mimo-bare',
          reasoning: { efforts: [] },
        },
      ],
    };
    useConfigStore.setState({ providers: [providerWithEmptyEfforts] });
    expect(useConfigStore.getState().getModelReasoning('v3', 'm3')).toEqual({
      efforts: [],
    });
  });

  it('returns null reasoning for an unknown provider or model', () => {
    useConfigStore.setState({ providers: [PROVIDER] });
    expect(useConfigStore.getState().getModelReasoning('gone', 'm1')).toBeNull();
    expect(useConfigStore.getState().getModelReasoning('v1', 'gone')).toBeNull();
  });

  it('resolves a catalog-provider model name from the loaded catalog by code', () => {
    const catalogProvider = {
      id: 'v4',
      kind: 'catalog' as const,
      name: 'OpenAI',
      piProvider: 'openai',
      apiKeyMasked: 'sk-…abcd',
      modelCodes: ['gpt-5'],
      models: [
        {
          code: 'gpt-5',
          reasoning: { efforts: [{ id: 'high', name: 'High' }] },
        },
      ],
    };
    useConfigStore.setState({
      providers: [catalogProvider],
      catalogProviders: [
        {
          id: 'openai',
          name: 'OpenAI',
          models: [{ code: 'gpt-5', name: 'GPT-5' }],
        },
      ],
    });
    const model = useConfigStore.getState().findModel('v4', 'gpt-5');
    expect(model).toEqual({
      id: 'gpt-5',
      name: 'GPT-5',
      code: 'gpt-5',
      reasoning: { efforts: [{ id: 'high', name: 'High' }] },
    });
    expect(
      useConfigStore.getState().getModelReasoning('v4', 'gpt-5'),
    ).toEqual({ efforts: [{ id: 'high', name: 'High' }] });
    expect(useConfigStore.getState().findModel('v4', 'missing')).toBeNull();
  });

  it('falls back to the code as the name when the catalog has not loaded or no longer lists it', () => {
    const catalogProvider = {
      id: 'v5',
      kind: 'catalog' as const,
      name: 'OpenAI',
      piProvider: 'openai',
      apiKeyMasked: 'sk-…abcd',
      modelCodes: ['gpt-5-legacy'],
      models: [{ code: 'gpt-5-legacy' }],
    };
    // Catalog not loaded at all.
    useConfigStore.setState({ providers: [catalogProvider], catalogProviders: [] });
    expect(useConfigStore.getState().findModel('v5', 'gpt-5-legacy')?.name).toBe(
      'gpt-5-legacy',
    );

    // Catalog loaded but no longer lists this code (stale config).
    useConfigStore.setState({
      catalogProviders: [{ id: 'openai', name: 'OpenAI', models: [] }],
    });
    expect(useConfigStore.getState().findModel('v5', 'gpt-5-legacy')?.name).toBe(
      'gpt-5-legacy',
    );
  });

  it('returns a reference-stable model for an unchanged catalog provider, and a fresh one once it changes', () => {
    // These are read through zustand selectors (`useConfigStore((s) =>
    // s.findModel(...))`), which compare snapshots by reference: rebuilding
    // the model object on every call is React's "getSnapshot should be cached"
    // infinite loop. Reference identity is the contract, not an optimization.
    const provider = {
      id: 'v6',
      kind: 'catalog' as const,
      name: 'OpenAI',
      piProvider: 'openai',
      apiKeyMasked: 'sk-…abcd',
      modelCodes: ['gpt-5'],
      models: [{ code: 'gpt-5', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }],
    };
    const catalog = [
      { id: 'openai', name: 'OpenAI', models: [{ code: 'gpt-5', name: 'GPT-5' }] },
    ];
    useConfigStore.setState({ providers: [provider], catalogProviders: catalog });

    const first = useConfigStore.getState().findModel('v6', 'gpt-5');
    expect(useConfigStore.getState().findModel('v6', 'gpt-5')).toBe(first);
    // Interleaving a call that passes no catalog (ChatPanel's default-model
    // path does exactly this) must not evict the selector's entry.
    providerModels(provider);
    expect(useConfigStore.getState().findModel('v6', 'gpt-5')).toBe(first);
    expect(useConfigStore.getState().getModelReasoning('v6', 'gpt-5')).toBe(
      first!.reasoning,
    );

    // A newly loaded catalog changes display names, so the cache must miss.
    useConfigStore.setState({
      catalogProviders: [
        { id: 'openai', name: 'OpenAI', models: [{ code: 'gpt-5', name: 'GPT-5 Turbo' }] },
      ],
    });
    const renamed = useConfigStore.getState().findModel('v6', 'gpt-5');
    expect(renamed).not.toBe(first);
    expect(renamed?.name).toBe('GPT-5 Turbo');
  });

  it("falls back to the catalog's token caps for a catalog model with no override", () => {
    const provider = {
      id: 'v7',
      kind: 'catalog' as const,
      name: 'OpenAI',
      piProvider: 'openai',
      apiKeyMasked: null,
      models: [
        // Overrides only one of the two caps; the other must inherit.
        { code: 'gpt-5', maxOutputTokens: 999 },
        { code: 'gpt-5-mini' },
      ],
    };
    useConfigStore.setState({
      providers: [provider],
      catalogProviders: [
        {
          id: 'openai',
          name: 'OpenAI',
          models: [
            {
              code: 'gpt-5',
              name: 'GPT-5',
              contextWindow: 400000,
              maxOutputTokens: 128000,
            },
            { code: 'gpt-5-mini', name: 'GPT-5 mini', contextWindow: 200000 },
          ],
        },
      ],
    });

    const overridden = useConfigStore.getState().findModel('v7', 'gpt-5');
    expect(overridden?.contextWindow).toBe(400000);
    expect(overridden?.maxOutputTokens).toBe(999);

    const inherited = useConfigStore.getState().findModel('v7', 'gpt-5-mini');
    expect(inherited?.contextWindow).toBe(200000);
    expect(inherited?.maxOutputTokens).toBeUndefined();
  });

  it('drops a removed provider from local state', async () => {
    useConfigStore.setState({ providers: [PROVIDER] });
    stubFetch({ 'DELETE /providers/v1': { removed: true } });
    await useConfigStore.getState().removeProvider('v1');
    expect(useConfigStore.getState().providers).toEqual([]);
  });
});
