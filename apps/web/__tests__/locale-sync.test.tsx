import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useTranslations } from 'next-intl';

// The switch is a provider state change, not a navigation: an exported build
// has no server render to refresh, so any router call here is a bug.
const refresh = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { I18nProvider } from '@/components/i18n-provider';
import { LocalePreferenceSync } from '@/components/locale-sync';
import { usePreferencesStore } from '@/stores/preferences-store';

function Probe() {
  const t = useTranslations('common');
  return <span>{t('meta.description')}</span>;
}

describe('LocalePreferenceSync', () => {
  beforeEach(() => {
    refresh.mockClear();
    document.cookie = 'volto_locale=; path=/; max-age=0';
    usePreferencesStore.setState({ preferences: {}, loaded: true });
  });

  it('switches the rendered copy to the stored locale and rewrites the cookie', () => {
    usePreferencesStore.setState({
      preferences: { locale: 'en' },
      loaded: true,
    });
    render(
      <I18nProvider locale="zh">
        <LocalePreferenceSync />
        <Probe />
      </I18nProvider>,
    );
    expect(document.cookie).toContain('volto_locale=en');
    expect(document.documentElement.lang).toBe('en');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does nothing when the rendered locale already matches', () => {
    usePreferencesStore.setState({
      preferences: { locale: 'zh' },
      loaded: true,
    });
    render(
      <I18nProvider locale="zh">
        <LocalePreferenceSync />
      </I18nProvider>,
    );
    expect(document.cookie).not.toContain('volto_locale=en');
    expect(refresh).not.toHaveBeenCalled();
  });
});
