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
          models: [{ code: 'claude-x' }],
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
              models: [{ code: 'claude-x' }],
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
      models: [{ code: 'claude-x' }],
    });
  });

  it('edits a catalog model as a form row and saves its overrides, never a reasoning flag', async () => {
    let putBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      async (input: string | URL, init?: { method?: string; body?: string }) => {
        const url = String(input);
        if (new URL(url).pathname === '/catalog/providers') {
          return { ok: true, json: async () => CATALOG } as Response;
        }
        if (init?.method === 'PUT') {
          putBody = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
          return { ok: true, json: async () => ({}) } as Response;
        }
        throw new Error(`Unstubbed route: ${url}`);
      },
    );

    const provider = {
      kind: 'catalog' as const,
      id: 'v9',
      name: 'Anthropic',
      piProvider: 'anthropic',
      apiKeyMasked: 'sk-…abcd',
      models: [
        { code: 'claude-x', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
      ],
    };
    useConfigStore.setState({ providers: [provider] });

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<CatalogProviderSection providers={[provider]} />);

    await user.click(await screen.findByRole('button', { name: '编辑供应商' }));

    // The model list is a form, not a checkbox list: the enabled model's own
    // fields are editable in place and no unticked catalog model is shown.
    expect(screen.getByDisplayValue('claude-x')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('claude-y')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    // Reasoning is pi-ai's fact about the model, never a control here.
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('显示名称 1'), '我的 Claude');
    await user.type(screen.getByLabelText('上下文窗口 1'), '200000');
    await user.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => expect(putBody).toBeDefined());
    expect(putBody).toMatchObject({
      kind: 'catalog',
      models: [
        { code: 'claude-x', name: '我的 Claude', contextWindow: 200000 },
      ],
    });
    expect(JSON.stringify(putBody)).not.toContain('reasoning');
  });
});
