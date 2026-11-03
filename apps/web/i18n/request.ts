/**
 * next-intl request config.
 *
 * There is no locale segment in the URL: the locale comes from the stored
 * preference (render-cached in a cookie) and, on a first visit, from the
 * browser's `Accept-Language`.
 */
import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE, resolveLocale } from './locale';
import zhCommon from '../messages/zh/common.json';
import zhChat from '../messages/zh/chat.json';
import zhSidebar from '../messages/zh/sidebar.json';
import zhPane from '../messages/zh/pane.json';
import zhSettings from '../messages/zh/settings.json';
import zhTrajectory from '../messages/zh/trajectory.json';
import enCommon from '../messages/en/common.json';
import enChat from '../messages/en/chat.json';
import enSidebar from '../messages/en/sidebar.json';
import enPane from '../messages/en/pane.json';
import enSettings from '../messages/en/settings.json';
import enTrajectory from '../messages/en/trajectory.json';

const MESSAGES = {
  zh: { common: zhCommon, chat: zhChat, sidebar: zhSidebar, pane: zhPane, settings: zhSettings, trajectory: zhTrajectory },
  en: { common: enCommon, chat: enChat, sidebar: enSidebar, pane: enPane, settings: enSettings, trajectory: enTrajectory },
} as const;

export default getRequestConfig(async () => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get('accept-language'),
  });
  return { locale, messages: MESSAGES[locale] };
});
