/**
 * Browser boot state: the locale and theme the first frame renders with.
 *
 * An exported build has no request to read cookies from, so both values are
 * decided in the browser before anything paints:
 *
 * - The inline head script (`browserBootScript`) runs during HTML parsing —
 *   before the first frame — and publishes them on `<html>` as
 *   `data-volto-theme` / `data-volto-locale`. next-themes' class, the
 *   `color-scheme` style and `<html lang>` are set there too, so the first
 *   paint already has the right theme and language.
 * - The app shell then reads the same attributes back (`readBrowserBoot`),
 *   so its first client render matches what is on screen.
 *
 * The inputs are shared with the providers, so no rule is stated twice: the
 * cookie names and the accepted theme values come from
 * `./theme-preference` (deliberately free of React and store imports, so
 * this module cannot drag the transport layer's cycle back into the layout),
 * the language tags from `./i18n/locale`, and the default language from
 * `@volto/i18n`. The rules themselves (`resolveInitialLocale`,
 * `THEME_VALUES`) are what both the script and the providers implement.
 */
import { DEFAULT_LOCALE, type Locale } from '@volto/i18n';
import { LOCALE_COOKIE, LOCALE_TAG } from '@/i18n/locale';
import { resolveInitialLocale } from '@/i18n/messages';
import {
  isThemePreference,
  THEME_COOKIE,
  THEME_VALUES,
  type ThemePreference,
} from './theme-preference';

/** `<html data-volto-theme>` — the theme preference the page booted with. */
export const THEME_ATTRIBUTE = 'data-volto-theme';
/** `<html data-volto-locale>` — the locale the page booted with. */
export const LOCALE_ATTRIBUTE = 'data-volto-locale';
/** Where `public/volto-config.js` is served from. */
export const CONFIG_SCRIPT_URL = '/volto-config.js';

export interface BrowserBoot {
  locale: Locale;
  theme: ThemePreference;
}

/** `["a", "b"]` — a JavaScript array literal inside the inline script. */
function jsLiterals(items: readonly string[]): string {
  return `[${items.map((item) => `"${item}"`).join(',')}]`;
}

/**
 * The boot state the head script published. Read by the client shell before
 * its first render; the defaults cover a caller that never ran the script,
 * including a server render (there is no document there).
 */
export function readBrowserBoot(
  root: HTMLElement | null = typeof document === 'undefined'
    ? null
    : document.documentElement,
): BrowserBoot {
  if (root === null) {
    return { theme: 'system', locale: resolveInitialLocale({}) };
  }
  const theme = root.getAttribute(THEME_ATTRIBUTE);
  return {
    theme: isThemePreference(theme) ? theme : 'system',
    locale: resolveInitialLocale({
      cookie: root.getAttribute(LOCALE_ATTRIBUTE) ?? undefined,
    }),
  };
}

/**
 * Source of the blocking inline script in the layout head.
 *
 * Everything it needs is inlined as literals — it runs during HTML parsing,
 * before any module bundle exists — exactly like `sidebarWidthRestoreScript`.
 * It resolves the same way the providers do: `volto_locale` cookie, else the
 * first shipped primary subtag of `navigator.languages`, else the default;
 * `volto_theme` cookie, else `system`.
 */
export function browserBootScript(): string {
  const shipped = jsLiterals(Object.keys(LOCALE_TAG));
  const localeTags = JSON.stringify(LOCALE_TAG);
  return (
    `try{` +
    // Cookie lookup: `; name=value` up to the next `;`; absent → null.
    `var get=function(name){` +
    `var c='; '+document.cookie,i=c.indexOf('; '+name+'=');` +
    `if(i<0)return null;i+=name.length+3;` +
    `var j=c.indexOf(';',i);return j<0?c.slice(i):c.slice(i,j)};` +
    `var theme=get('${THEME_COOKIE}');` +
    `if(${jsLiterals(THEME_VALUES)}.indexOf(theme)<0)theme='system';` +
    `var locale=get('${LOCALE_COOKIE}');` +
    `if(${shipped}.indexOf(locale)<0)locale=null;` +
    `if(!locale){` +
    `var langs=navigator.languages||[];` +
    `for(var n=0;n<langs.length;n++){` +
    `var primary=String(langs[n]||'').split('-')[0].toLowerCase();` +
    `if(${shipped}.indexOf(primary)>=0){locale=primary;break}}}` +
    `if(!locale)locale='${DEFAULT_LOCALE}';` +
    `var root=document.documentElement;` +
    `root.setAttribute('${THEME_ATTRIBUTE}',theme);` +
    `root.setAttribute('${LOCALE_ATTRIBUTE}',locale);` +
    `root.setAttribute('lang',${localeTags}[locale]);` +
    `var dark=theme==='system'` +
    `?!!(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)` +
    `:theme==='dark';` +
    `root.classList[dark?'add':'remove']('dark');` +
    `root.style.colorScheme=dark?'dark':'light';` +
    // The deployment's runtime config must be readable whichever entry point
    // ran first. `public/volto-config.js` defines the same global; this only
    // fills in the same-origin default (`gatewayUrl: ""`), never overrides a
    // value the deployment already injected.
    `window.__VOLTO_CONFIG__=window.__VOLTO_CONFIG__||{gatewayUrl:''}` +
    `}catch(e){}`
  );
}
