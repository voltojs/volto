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
