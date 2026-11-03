/**
 * A message's timestamp, complete enough to identify the moment without
 * hovering or opening anything: local date, hours, minutes and seconds.
 *
 * Rendered by hand rather than through `Intl` because the feed wants one
 * stable, sortable shape (`YYYY-MM-DD HH:mm:ss`) in every locale — a
 * locale-formatted string changes width and order per browser language, and
 * the footer is a scanning aid, not prose.
 */
export function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Clock time (HH:mm) for a feed row's timestamp, in the reader's locale.
 *
 * The date part stays out: rows sit in one conversation where the day is
 * obvious, and a locale-formatted date would change the row's width. Built
 * from `Intl` here (not inline in each component) so the locale follows the
 * UI language instead of a hardcoded `zh-CN`.
 */
export function formatClockTime(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
}

/**
 * Short date-time for a session row or a trace detail: date and time, in the
 * reader's locale (was hardcoded `zh-CN`, which leaked the Chinese layout into
 * the English UI).
 */
export function formatShortDateTime(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(ms);
}
