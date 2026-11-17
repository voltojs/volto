/**
 * Whether the page runs inside the desktop host. The blocking boot script
 * publishes this on `<html>` before paint, so reading it during a client
 * render is stable; a server render has no document and falls back to `web`.
 */
export function isDesktopShell(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-volto-shell') === 'desktop'
  );
}
