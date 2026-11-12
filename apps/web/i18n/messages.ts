/**
 * The Web shell's message catalogs and the rule that picks one.
 *
 * The static export has no server request to render messages with, so every
 * catalog is imported statically and the language is decided in the browser.
 * This is the single place that maps a locale to its six namespaces: the
 * provider renders from it, the parity test compares it, and the boot path
 * resolves the initial locale through it.
 */
import type { AbstractIntlMessages } from 'next-intl';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@volto/i18n';
import zhCommon from '@/messages/zh/common.json';
import zhChat from '@/messages/zh/chat.json';
import zhSidebar from '@/messages/zh/sidebar.json';
import zhPane from '@/messages/zh/pane.json';
import zhSettings from '@/messages/zh/settings.json';
import zhTrajectory from '@/messages/zh/trajectory.json';
import enCommon from '@/messages/en/common.json';
import enChat from '@/messages/en/chat.json';
import enSidebar from '@/messages/en/sidebar.json';
import enPane from '@/messages/en/pane.json';
import enSettings from '@/messages/en/settings.json';
import enTrajectory from '@/messages/en/trajectory.json';

/** A shipped language tag. The catalog map is exactly this wide. */
export type { Locale } from '@volto/i18n';

/** The namespaces both locales must carry, with identical keys. */
export const NAMESPACES = [
  'common',
  'chat',
  'sidebar',
  'pane',
  'settings',
  'trajectory',
] as const;

export type Namespace = (typeof NAMESPACES)[number];

export const MESSAGES: Record<
  Locale,
  Record<Namespace, AbstractIntlMessages>
> = {
  zh: {
    common: zhCommon,
    chat: zhChat,
    sidebar: zhSidebar,
    pane: zhPane,
    settings: zhSettings,
    trajectory: zhTrajectory,
  },
  en: {
    common: enCommon,
    chat: enChat,
    sidebar: enSidebar,
    pane: enPane,
    settings: enSettings,
    trajectory: enTrajectory,
  },
};

/**
 * Picks the locale for a page load: the stored preference (cookie), then the
 * first shipped language named by the browser, then the default.
 *
 * Reads only what the caller passes in — there is no request to consult once
 * the app is exported as plain files, so the caller supplies the cookie and
 * `navigator.languages`.
 */
export function resolveInitialLocale(input: {
  /** `volto_locale` cookie, if the user ever picked a language. */
  cookie?: string;
  /** `navigator.languages`, most preferred first. */
  languages?: readonly string[];
}): Locale {
  if (isLocale(input.cookie)) return input.cookie;
  for (const language of input.languages ?? []) {
    // "en-US" → "en"; the primary subtag is what we match.
    const primary = language.split('-')[0]?.trim().toLowerCase() ?? '';
    if (isLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}
