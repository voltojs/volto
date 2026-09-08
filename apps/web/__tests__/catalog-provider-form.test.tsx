/**
 * CatalogProviderSection tests. Stubs `fetch` for `/catalog/providers` and
 * for the create/update provider requests, same convention as
 * config-store.test.ts.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CatalogProviderSection } from '@/components/settings/CatalogProviderForm';
import { useConfigStore } from '@/stores/config-store';
import { SERVER_URL } from '@/lib/agent-config';

// jsdom does not implement the pointer-capture / scroll APIs Base UI's
// Select uses internally; stub them so the popup can open in tests.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const CATALOG = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    models: [
      { code: 'claude-x', name: 'Claude X', reasoning: true },
      { code: 'claude-y', name: 'Claude Y' },
    ],
  },
];

function stubFetch(routes: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    async (input: string | URL, init?: { method?: string; body?: string }) => {
      const url = String(input);
      const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
      const body = routes[key];
      if (body === undefined) throw new Error(`Unstubbed route: ${key}`);
      return { ok: true, json: async () => body } as Response;
    },
  );
}

beforeEach(() => {
  useConfigStore.setState({ providers: [], loaded: false, error: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CatalogProviderSection', () => {
  it('lists providers from the catalog API and lets a model be ticked', async () => {
    stubFetch({ 'GET /catalog/providers': CATALOG });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<CatalogProviderSection providers={[]} />);

    await user.click(await screen.findByText('新增内置 Provider'));

    // The catalog provider is selected by default (first entry), so its
    // models render without any further picking.
    expect(await screen.findByText('Claude X')).toBeInTheDocument();
    expect(screen.getByText('Claude Y')).toBeInTheDocument();

    const checkbox = screen.getByRole('checkbox', { name: /Claude X/ });
    await user.click(checkbox);
    expect(checkbox).toHaveAttribute('data-checked');
  });

  it('creates a catalog provider with the ticked model codes, never a hand-typed code', async () => {
    let createdBody: unknown;
    stubFetch({
      'GET /catalog/providers': CATALOG,
      'POST /providers': (() => {
        return {
          kind: 'catalog',
          id: 'p1',
          name: 'Anthropic',
          piProvider: 'anthropic',
          apiKeyMasked: 'sk-…abcd',
          modelCodes: ['claude-x'],
        };
      })(),
    });
    vi.stubGlobal(
      'fetch',
      async (input: string | URL, init?: { method?: string; body?: string }) => {
        const url = String(input);
        if (init?.method === 'POST' && url === `${SERVER_URL}/providers`) {
          createdBody = JSON.parse(init.body ?? '{}');
          return {
            ok: true,
            json: async () => ({
              kind: 'catalog',
              id: 'p1',
              name: 'Anthropic',
              piProvider: 'anthropic',
              apiKeyMasked: 'sk-…abcd',
              modelCodes: ['claude-x'],
            }),
          } as Response;
        }
        if (url === `${SERVER_URL}/catalog/providers`) {
          return { ok: true, json: async () => CATALOG } as Response;
        }
        throw new Error(`Unstubbed route: ${url}`);
      },
    );

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<CatalogProviderSection providers={[]} />);

    await user.click(await screen.findByText('新增内置 Provider'));
    await user.click(await screen.findByRole('checkbox', { name: /Claude X/ }));
    await user.type(screen.getByPlaceholderText('apiKey'), 'sk-test');
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(createdBody).toBeDefined());
    expect(createdBody).toMatchObject({
      kind: 'catalog',
      piProvider: 'anthropic',
      apiKey: 'sk-test',
      modelCodes: ['claude-x'],
    });
  });
});
