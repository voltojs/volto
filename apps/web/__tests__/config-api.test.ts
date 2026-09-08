/**
 * Config API client tests for the catalog endpoint. Stubs fetch rather than
 * talking to a real gateway, same convention as config-store.test.ts.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchCatalogProviders } from '../lib/config-api.js';
import { SERVER_URL } from '../lib/agent-config.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchCatalogProviders', () => {
  it('returns the parsed catalog provider list', async () => {
    const catalog = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: [
          { code: 'claude-x', name: 'Claude X', reasoning: true },
          { code: 'claude-y', name: 'Claude Y' },
        ],
      },
    ];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      expect(String(input)).toBe(`${SERVER_URL}/catalog/providers`);
      return { ok: true, json: async () => catalog } as Response;
    });

    const result = await fetchCatalogProviders();
    expect(result).toEqual(catalog);
  });
});
