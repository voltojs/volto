/**
 * Locale resolution for the Web shell.
 *
 * The stored preference is the source of truth; the cookie only caches it for
 * the first server render, and `Accept-Language` is the first-run default.
 * Pure and framework-free so the RSC config and the tests share one rule.
 */
import { DEFAULT_LOCALE, isLocale, type Locale } from '@volto/i18n';

/** Cookie holding the last locale the user chose, readable during RSC. */
export const LOCALE_COOKIE = 'volto_locale';

/**
 * Picks the locale for a request: stored preference, then cookie, then the
 * first shipped language named by `Accept-Language`, then the default.
 */
export function resolveLocale(input: {
  /** `preferences.locale` from the gateway. */
  preference?: string;
  /** `volto_locale` cookie (render cache of the preference). */
  cookie?: string;
  /** Raw `Accept-Language` header. */
  acceptLanguage?: string | null;
}): Locale {
  if (isLocale(input.preference)) return input.preference;
  if (isLocale(input.cookie)) return input.cookie;
  const fromHeader = firstSupported(input.acceptLanguage ?? '');
  return fromHeader ?? DEFAULT_LOCALE;
}

/** First shipped locale mentioned in an `Accept-Language` header, if any. */
function firstSupported(header: string): Locale | undefined {
  for (const part of header.split(',')) {
    // "en-US;q=0.9" → "en-us"; the primary subtag is what we match.
    const tag = part.split(';')[0]?.trim().toLowerCase() ?? '';
    const primary = tag.split('-')[0];
    if (isLocale(primary)) return primary;
  }
  return undefined;
}
