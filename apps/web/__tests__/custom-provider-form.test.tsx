/**
 * CustomProviderSection tests: every pre-existing field (name, baseURL, key,
 * model list, contextWindow, maxOutputTokens) must round-trip through save,
 * plus the new per-model "supports reasoning" toggle.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CustomProviderSection } from '@/components/settings/CustomProviderForm';
import { useConfigStore, type Provider } from '@/stores/config-store';
import { SERVER_URL } from '@/lib/agent-config';

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

beforeEach(() => {
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
        if (init?.method === 'PUT' && url === `${SERVER_URL}/providers/v1`) {
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
});
