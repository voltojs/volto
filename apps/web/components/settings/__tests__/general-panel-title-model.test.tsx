/**
 * The "标题模型" row: which model (if any) names new sessions. Picking one
 * persists the provider/model pair through /preferences; "不使用" clears both
 * so the gateway falls back to truncating the first message.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}));

import { GeneralPanel } from '../GeneralPanel';
import { I18nProvider } from '@/components/i18n-provider';
import { useConfigStore, type Provider } from '@/stores/config-store';
import { usePreferencesStore } from '@/stores/preferences-store';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// jsdom lacks the pointer-capture / scroll APIs Base UI's Select uses.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const PROVIDERS: Provider[] = [
  {
    kind: 'custom',
    id: 'v1',
    name: 'Xiaomi',
    baseURL: null,
    apiKeyMasked: null,
    models: [{ id: 'm1', name: 'MiMo-V2.5', code: 'mimo-v2.5' }],
  },
  {
    kind: 'custom',
    id: 'v2',
    name: 'Anthropic',
    baseURL: null,
    apiKeyMasked: null,
    models: [{ id: 'c1', name: 'Claude X', code: 'claude-x' }],
  },
];

let fetchSpy: MockInstance<typeof globalThis.fetch>;

beforeEach(() => {
  window.localStorage.clear();
  usePreferencesStore.setState({ preferences: {}, loaded: true });
  useConfigStore.setState({ providers: PROVIDERS, catalogProviders: [] });
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The title-model select is the last row of the panel. */
function titleModelSelect(): HTMLElement {
  const selects = screen.getAllByRole('combobox');
  return selects[selects.length - 1]!;
}

/** The parsed body of the most recent /preferences PUT. */
function lastPreferencesPatch(): Record<string, unknown> {
  const call = fetchSpy.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
    .at(-1);
  return JSON.parse(((call?.[1] as RequestInit).body as string) ?? '{}') as Record<
    string,
    unknown
  >;
}

describe('GeneralPanel title model', () => {
  it('offers every configured model plus an explicit opt-out', async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="zh">
        <GeneralPanel />
      </I18nProvider>,
    );

    expect(screen.getByText('标题模型')).toBeInTheDocument();
    await user.click(titleModelSelect());

    expect(await screen.findByRole('option', { name: /不使用/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /MiMo-V2\.5/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Claude X/ })).toBeInTheDocument();
  });

  it('persists the picked provider and model', async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="zh">
        <GeneralPanel />
      </I18nProvider>,
    );

    await user.click(titleModelSelect());
    await user.click(await screen.findByRole('option', { name: /MiMo-V2\.5/ }));

    expect(lastPreferencesPatch()).toEqual({
      titleProviderId: 'v1',
      titleModelId: 'm1',
    });
  });

  it('clears both keys when "不使用" is picked', async () => {
    usePreferencesStore.setState({
      preferences: { titleProviderId: 'v1', titleModelId: 'm1' },
      loaded: true,
    });
    const user = userEvent.setup();
    render(
      <I18nProvider locale="zh">
        <GeneralPanel />
      </I18nProvider>,
    );

    // Provider-qualified, because two providers can carry the same model id.
    expect(screen.getByText('Xiaomi / MiMo-V2.5')).toBeInTheDocument();

    await user.click(titleModelSelect());
    await user.click(await screen.findByRole('option', { name: /不使用/ }));

    expect(lastPreferencesPatch()).toEqual({ titleProviderId: '', titleModelId: '' });
  });

  it('says so when the stored model no longer exists', () => {
    usePreferencesStore.setState({
      preferences: { titleProviderId: 'gone', titleModelId: 'gone-model' },
      loaded: true,
    });
    render(
      <I18nProvider locale="zh">
        <GeneralPanel />
      </I18nProvider>,
    );

    expect(screen.getByText('已失效，请重选')).toBeInTheDocument();
  });
});
