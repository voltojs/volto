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
import enCommon from '../messages/en/common.json';
import enChat from '../messages/en/chat.json';

const MESSAGES = {
  zh: { common: zhCommon, chat: zhChat },
  en: { common: enCommon, chat: enChat },
} as const;

export default getRequestConfig(async () => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get('accept-language'),
  });
  return { locale, messages: MESSAGES[locale] };
});
