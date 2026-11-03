'use client';

/**
 * Keeps the rendered locale in step with the stored preference.
 *
 * The server render can only see the `volto_locale` cookie (it never reads
 * `~/.volto/config.json` directly), so a fresh browser — or one whose cookie
 * was cleared — may render the Accept-Language language while the user's stored
 * preference says otherwise. Once the preferences arrive, the stored value
 * wins: refresh the cookie and re-render the server output.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { usePreferencesStore } from '@/stores/preferences-store';
import { LOCALE_COOKIE } from '@/i18n/locale';

export function LocalePreferenceSync() {
  const locale = useLocale();
  const stored = usePreferencesStore((s) => s.preferences.locale);
  const load = usePreferencesStore((s) => s.load);
  const router = useRouter();

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (stored === undefined || stored === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${stored}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }, [stored, locale, router]);

  return null;
}
