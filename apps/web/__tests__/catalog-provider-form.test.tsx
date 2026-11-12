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
import { GATEWAY_URL_KEY, resetGatewayBaseForTest } from '@/lib/gateway-base';

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
    baseUrl: 'https://api.anthropic.com',
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
      const key = `${init?.method ?? 'GET'} ${url}`;
      const body = routes[key];
      if (body === undefined) throw new Error(`Unstubbed route: ${key}`);
      return { ok: true, json: async () => body } as Response;
    },
  );
}

// A fixed absolute base keeps the route table readable; the resolver itself
// is covered by gateway-base.test.ts.
const GATEWAY_BASE = 'http://gw.test';

beforeEach(() => {
  localStorage.setItem(GATEWAY_URL_KEY, GATEWAY_BASE);
  resetGatewayBaseForTest();
  useConfigStore.setState({ providers: [], loaded: false, error: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CatalogProviderSection', () => {
  it('does not offer a pi-ai provider that is already configured', async () => {
    stubFetch({ [`GET ${GATEWAY_BASE + '/catalog/providers'}`]: CATALOG });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    const existing = {
      kind: 'catalog' as const,
      id: 'v1',
      name: 'Anthropic',
      piProvider: 'anthropic',
      baseURL: null,
      apiKeyMasked: null,
      models: [],
    };
    render(<CatalogProviderSection providers={[existing]} />);

    // CATALOG has exactly one provider, and it is already configured — the
    // gateway would reject a second record, so the entry point is closed
    // rather than leading into a form that cannot be submitted.
    const addButton = await screen.findByText('内置 Provider 已全部配置');
    expect(addButton.closest('button')).toBeDisabled();
    await user.click(addButton);
    expect(screen.queryByPlaceholderText('apiKey')).not.toBeInTheDocument();
  });

  it('adds models to the new provider through the same table as the edit form', async () => {
    stubFetch({ [`GET ${GATEWAY_BASE + '/catalog/providers'}`]: CATALOG });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<CatalogProviderSection providers={[]} />);

    await user.click(await screen.findByText('新增内置 Provider'));

    // A table, not a pre-checked catalog dump — and it starts empty rather
    // than seeded with the provider's whole catalog (several list dozens of
    // models).
    expect(screen.queryByLabelText('模型 ID 1')).not.toBeInTheDocument();

    await user.click(await screen.findByText('新增模型'));
    const code = screen.getByLabelText('模型 ID 1');
    // Codes autocomplete from the selected provider's catalog.
    expect(code).toHaveAttribute('list', 'catalog-models-new');
    expect(
      document.querySelector('#catalog-models-new option[value="claude-x"]'),
    ).not.toBeNull();

    await user.type(code, 'claude-x');
    // Once the code matches a catalog model, its values show as the
    // placeholders each empty override box would inherit.
    expect(screen.getByLabelText('显示名称 1')).toHaveAttribute(
      'placeholder',
      'Claude X',
    );
    // The catalog's reasoning flag seeds the row's checkbox, so a newly
    // added reasoning model starts checked and is still user-toggleable.
    expect(screen.getByRole('checkbox', { name: /支持推理/ })).toBeChecked();
  });

  it('bulk-adds unselected catalog models through the available-models dialog', async () => {
    stubFetch({ [`GET ${GATEWAY_BASE + '/catalog/providers'}`]: CATALOG });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    render(<CatalogProviderSection providers={[]} />);
    await user.click(await screen.findByText('新增内置 Provider'));

    // Seed one model by hand so the dialog must exclude it.
    await user.click(await screen.findByText('新增模型'));
    await user.type(screen.getByLabelText('模型 ID 1'), 'claude-x');

    await user.click(screen.getByRole('button', { name: /获取可用模型/ }));
    // Dialog body text is unique — the trigger button shares the title string.
    expect(
      await screen.findByText('从该 Provider 的目录中勾选尚未添加的模型。'),
    ).toBeInTheDocument();
    expect(screen.queryByText('claude-x')).not.toBeInTheDocument();
    expect(screen.getByText('claude-y')).toBeInTheDocument();

    // Tick the row via its label, then confirm.
    await user.click(screen.getByText('claude-y'));
    await user.click(screen.getByRole('button', { name: /添加/ }));

    // Dialog closed; the draft now has both rows.
    expect(
      screen.queryByText('从该 Provider 的目录中勾选尚未添加的模型。'),
    ).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('claude-x')).toBeInTheDocument();
    expect(screen.getByDisplayValue('claude-y')).toBeInTheDocument();
    // claude-y has no catalog reasoning flag, so its checkbox starts off.
    const reasoningBoxes = screen.getAllByRole('checkbox', { name: /支持推理/ });
    expect(reasoningBoxes).toHaveLength(2);
    expect(reasoningBoxes[0]).toBeChecked();
    expect(reasoningBoxes[1]).not.toBeChecked();
  });

  it('creates a catalog provider with the table\'s rows and an optional baseURL override', async () => {
    let createdBody: unknown;
    stubFetch({
      [`GET ${GATEWAY_BASE + '/catalog/providers'}`]: CATALOG,
      [`POST ${GATEWAY_BASE + '/providers'}`]: (() => {
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
        if (init?.method === 'POST' && url === GATEWAY_BASE + '/providers') {
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
        if (url === GATEWAY_BASE + '/catalog/providers') {
          return { ok: true, json: async () => CATALOG } as Response;
        }
        throw new Error(`Unstubbed route: ${url}`);
      },
    );

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<CatalogProviderSection providers={[]} />);

    await user.click(await screen.findByText('新增内置 Provider'));
    await user.click(await screen.findByText('新增模型'));
    await user.type(screen.getByLabelText('模型 ID 1'), 'claude-x');
    await user.type(screen.getByPlaceholderText('apiKey'), 'sk-test');
    await user.type(
      screen.getByPlaceholderText('https://api.anthropic.com'),
      'https://mirror.internal',
    );
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(createdBody).toBeDefined());
    expect(createdBody).toMatchObject({
      kind: 'catalog',
      piProvider: 'anthropic',
      apiKey: 'sk-test',
      baseURL: 'https://mirror.internal',
      // claude-x is reasoning-capable in CATALOG, so the seeded checkbox
      // submits `reasoning: true` as an explicit override.
      models: [{ code: 'claude-x', reasoning: true }],
    });
  });

  it('edits a catalog model as a form row and saves a reasoning override', async () => {
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
      baseURL: null,
      apiKeyMasked: 'sk-…abcd',
      models: [
        { code: 'claude-x', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
      ],
    };
    useConfigStore.setState({ providers: [provider] });

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<CatalogProviderSection providers={[provider]} />);

    await user.click(await screen.findByRole('button', { name: '编辑供应商' }));

    // The model list is a form: the enabled model's own fields are editable
    // in place and no unticked catalog model is shown.
    expect(screen.getByDisplayValue('claude-x')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('claude-y')).not.toBeInTheDocument();
    // Reasoning is an editable checkbox seeded from the resolved capability.
    const reasoning = screen.getByRole('checkbox', { name: /支持推理/ });
    expect(reasoning).toBeChecked();

    await user.type(screen.getByLabelText('显示名称 1'), '我的 Claude');
    await user.type(screen.getByLabelText('上下文窗口 1'), '200000');
    // User unchecks reasoning; the save body carries the explicit override.
    await user.click(reasoning);
    // Provider-level fields live in the defaults panel, collapsed on edit.
    await user.click(screen.getByText('Provider 默认配置'));
    // baseURL is editable here too, and empty means "use pi-ai's address".
    await user.type(
      screen.getByPlaceholderText('https://api.anthropic.com'),
      'https://mirror.internal',
    );
    await user.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => expect(putBody).toBeDefined());
    expect(putBody).toMatchObject({
      kind: 'catalog',
      baseURL: 'https://mirror.internal',
      models: [
        {
          code: 'claude-x',
          name: '我的 Claude',
          contextWindow: 200000,
          reasoning: false,
        },
      ],
    });
  });
});
