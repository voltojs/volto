/**
 * CustomProviderSection tests: every pre-existing field (name, baseURL, key,
 * model list, contextWindow, maxOutputTokens) must round-trip through save,
 * plus the new per-model "supports reasoning" toggle.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CustomProviderSection } from '@/components/settings/CustomProviderForm';
import { useConfigStore, type Provider } from '@/stores/config-store';
import { GATEWAY_URL_KEY, resetGatewayBaseForTest } from '@/lib/gateway-base';

const PROVIDER: Provider = {
  kind: 'custom',
  id: 'v1',
  name: 'MiMo',
  baseURL: 'https://example.com/v1',
  apiKeyMasked: 'sk-…3f2a',
  models: [
    {
      id: 'm1',
      name: 'MiMo-V2.5-Pro',
      code: 'mimo-v2.5',
      contextWindow: 128000,
      maxOutputTokens: 4096,
    },
  ],
};

// A fixed absolute base keeps the stubbed URL readable; the resolver itself is
// covered by gateway-base.test.ts.
beforeEach(() => {
  localStorage.setItem(GATEWAY_URL_KEY, 'http://gw.test');
  resetGatewayBaseForTest();
  useConfigStore.setState({ providers: [PROVIDER], loaded: true, error: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CustomProviderSection', () => {
  it('round-trips every pre-existing field plus the reasoning toggle on save', async () => {
    let putBody: unknown;
    vi.stubGlobal(
      'fetch',
      async (input: string | URL, init?: { method?: string; body?: string }) => {
        const url = String(input);
        if (init?.method === 'PUT' && url === 'http://gw.test/providers/v1') {
          const parsed = JSON.parse(init.body ?? '{}') as Record<
            string,
            unknown
          >;
          putBody = parsed;
          return {
            ok: true,
            json: async () => ({ ...PROVIDER, ...parsed }),
          } as Response;
        }
        throw new Error(`Unstubbed route: ${url}`);
      },
    );

    const user = userEvent.setup();
    render(<CustomProviderSection providers={[PROVIDER]} />);

    // Collapsed by default: the row shows identity only, no form.
    expect(screen.getByText('MiMo')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('mimo-v2.5')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '编辑供应商' }));
    // Provider defaults are collapsed by default; open them to edit them.
    await user.click(screen.getByText('Provider 默认配置'));

    // All pre-existing fields are visible, pre-filled from the provider.
    expect(screen.getByDisplayValue('MiMo')).toBeInTheDocument();
    expect(
      screen.getByDisplayValue('https://example.com/v1'),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('MiMo-V2.5-Pro')).toBeInTheDocument();
    expect(screen.getByDisplayValue('mimo-v2.5')).toBeInTheDocument();
    expect(screen.getByDisplayValue('128000')).toBeInTheDocument();
    expect(screen.getByDisplayValue('4096')).toBeInTheDocument();

    // Flip the reasoning checkbox on, then save.
    await user.click(screen.getByRole('checkbox', { name: /支持推理/ }));
    await user.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => expect(putBody).toBeDefined());
    expect(putBody).toMatchObject({
      kind: 'custom',
      name: 'MiMo',
      baseURL: 'https://example.com/v1',
      models: [
        {
          id: 'm1',
          name: 'MiMo-V2.5-Pro',
          code: 'mimo-v2.5',
          contextWindow: 128000,
          maxOutputTokens: 4096,
          reasoning: true,
        },
      ],
    });
  });

  it('submits a seeded thinkingLevelMap verbatim and omits the key when the map is empty', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      async (input: string | URL, init?: { method?: string; body?: string }) => {
        const url = String(input);
        if (init?.method === 'PUT' && url === 'http://gw.test/providers/v1') {
          const parsed = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
          bodies.push(parsed);
          return {
            ok: true,
            json: async () => ({ ...PROVIDER, ...parsed }),
          } as Response;
        }
        throw new Error(`Unstubbed route: ${url}`);
      },
    );

    // GET /providers custom model carrying both new fields: the stored map
    // (editable draft seed) and the resolved levels inside `reasoning`.
    const provider: Provider = {
      ...PROVIDER,
      models: [
        {
          ...PROVIDER.models[0]!,
          reasoning: {
            efforts: [{ id: 'high', name: 'High' }],
            levels: [
              { id: 'off', supported: true, overridden: false },
              { id: 'high', supported: true, value: 'high', overridden: true },
            ],
          },
          thinkingLevelMap: { high: 'highest' },
        },
      ],
    };

    const user = userEvent.setup();
    render(<CustomProviderSection providers={[provider]} />);
    await user.click(screen.getByRole('button', { name: '编辑供应商' }));
    await user.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => expect(bodies[0]).toBeDefined());
    let savedModels = bodies[0]!.models as Array<Record<string, unknown>>;
    // The untouched stored map round-trips verbatim.
    expect(savedModels[0]).toMatchObject({
      code: 'mimo-v2.5',
      thinkingLevelMap: { high: 'highest' },
    });

    // Turning the toggle off clears the draft's map (Task 6 owns that UI);
    // from there the submit conversion must drop the key entirely — an
    // empty map means "no override". Simulate the cleared draft by saving
    // a record whose wire map is `{}` in a fresh render.
    useConfigStore.setState({ providers: [] });
    cleanup();
    const cleared: Provider = {
      ...provider,
      models: [{ ...provider.models[0]!, thinkingLevelMap: {} }],
    };
    const user2 = userEvent.setup();
    render(<CustomProviderSection providers={[cleared]} />);
    await user2.click(screen.getByRole('button', { name: '编辑供应商' }));
    await user2.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => expect(bodies[1]).toBeDefined());
    savedModels = bodies[1]!.models as Array<Record<string, unknown>>;
    expect(savedModels[0]).not.toHaveProperty('thinkingLevelMap');
  });
});
