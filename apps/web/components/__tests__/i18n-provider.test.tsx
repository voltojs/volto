import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

// The shared setup mocks next-intl's lookup against the zh catalog; this spec
// must exercise the real provider with the real catalogs instead.
import { vi } from 'vitest';

vi.unmock('next-intl');

import { useTranslations } from 'next-intl';
import enCommon from '@/messages/en/common.json';
import { I18nProvider, useLocalePreference } from '../i18n-provider';

function Probe() {
  const t = useTranslations('common');
  const { locale } = useLocalePreference();
  return (
    <>
      <span>{t('meta.description')}</span>
      <span data-testid="locale">{locale}</span>
    </>
  );
}

// "Volto" appears in both catalogs, so only the English sentence can tell the
// two renders apart: the zh copy must be gone too.
it('renders the copy of the requested locale', () => {
  render(
    <I18nProvider locale="en">
      <Probe />
    </I18nProvider>,
  );

  expect(screen.getByText(enCommon.meta.description)).toBeInTheDocument();
  expect(screen.getByTestId('locale')).toHaveTextContent('en');
  expect(screen.queryByText(/项目级/)).not.toBeInTheDocument();
});

it('fails loudly when a consumer is rendered without the provider', () => {
  // Its own component so that the hook's error is the first one next-intl
  // could raise (`useTranslations` has no provider either).
  function Unwired() {
    const { setLocale } = useLocalePreference();
    return <button onClick={() => setLocale('en')}>switch</button>;
  }
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

  expect(() => render(<Unwired />)).toThrow(
    'useLocalePreference must be used inside <I18nProvider>',
  );

  quiet.mockRestore();
});
