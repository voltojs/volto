'use client';

/**
 * Client-side i18n. There is no server request to render messages with: the
 * static export ships every catalog, and the layout picks the language from
 * the `volto_locale` cookie (pre-injected into a placeholder in `<head>`, so
 * the first client render already matches what the page will show).
 *
 * Switching locale is a state change here — no navigation, no
 * `router.refresh()` — which is what makes it work once the app is exported
 * as plain files.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { LOCALE_COOKIE, LOCALE_TAG } from '@/i18n/locale';
import { MESSAGES, type Locale } from '@/i18n/messages';

/** The language the UI is rendering in, plus a way to change it. */
interface LocalePreference {
  locale: Locale;
  /** Renders the UI in `locale` and remembers it for the next page load. */
  setLocale: (locale: Locale) => void;
}

const LocalePreferenceContext = createContext<LocalePreference | null>(null);

/**
 * Locale of the running UI.
 *
 * Returns `null` outside a provider rather than throwing: every consumer
 * (components, the preference sync) is also rendered by component tests that
 * only need `useTranslations` from the setup's next-intl mock.
 */
export function useLocalePreference(): LocalePreference | null {
  return useContext(LocalePreferenceContext);
}

/**
 * Applies a locale choice to the document. `document.documentElement.lang`
 * was server-rendered as the default language and is corrected here; the
 * cookie is what a later page load boots from.
 */
export function commitLocale(locale: Locale): void {
  document.documentElement.lang = LOCALE_TAG[locale];
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}

export function I18nProvider({
  locale: initialLocale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    commitLocale(next);
  }, []);

  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);

  return (
    <LocalePreferenceContext.Provider value={value}>
      <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
        {children}
      </NextIntlClientProvider>
    </LocalePreferenceContext.Provider>
  );
}