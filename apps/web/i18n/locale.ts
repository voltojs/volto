/**
 * Locale plumbing for the Web shell: the cookie the choice is remembered in
 * and the `lang` attribute each shipped language renders as.
 *
 * The rules that pick a locale live in `./messages`, next to the catalogs
 * they resolve to.
 */
import type { Locale } from './messages';

/** Cookie holding the last locale the user chose, readable from the browser. */
export const LOCALE_COOKIE = 'volto_locale';

/** `document.documentElement.lang` for each shipped locale. */
export const LOCALE_TAG: Record<Locale, string> = {
  zh: 'zh-CN',
  en: 'en',
};
