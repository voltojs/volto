/**
 * Config API client tests for the catalog endpoint. Stubs fetch rather than
 * talking to a real gateway, same convention as config-store.test.ts.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { GATEWAY_URL_KEY, resetGatewayBaseForTest } from '../lib/gateway-base.js';
import { fetchCatalogProviders } from '../lib/config-api.js';

// A fixed absolute base keeps the assertions readable; the resolver itself is
// covered by gateway-base.test.ts.
beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === GATEWAY_URL_KEY ? 'http://gw.test' : null),
  });
  resetGatewayBaseForTest();
});

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
      expect(String(input)).toBe('http://gw.test/catalog/providers');
      return { ok: true, json: async () => catalog } as Response;
    });

    const result = await fetchCatalogProviders();
    expect(result).toEqual(catalog);
  });
});
