'use client';

/**
 * Keeps the rendered locale in step with the stored preference.
 *
 * The server render can only see the `volto_locale` cookie (it never reads
 * `~/.volto/config.json` directly), so a fresh browser — or one whose cookie
 * was cleared — may render the browser's language while the user's stored
 * preference says otherwise. Once the preferences arrive, the stored value
 * wins: `setLocale` re-renders the provider and rewrites the cookie. No
 * `router.refresh()` — an exported build has no server render to redo.
 */
import { useEffect } from 'react';
import { useLocalePreference } from '@/components/i18n-provider';
import { usePreferencesStore } from '@/stores/preferences-store';

export function LocalePreferenceSync() {
  const { locale, setLocale } = useLocalePreference();
  const stored = usePreferencesStore((s) => s.preferences.locale);
  const load = usePreferencesStore((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (stored === undefined || stored === locale) return;
    setLocale(stored);
  }, [stored, locale, setLocale]);

  return null;
}