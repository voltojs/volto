/**
 * Whether the page runs inside the desktop host. The blocking boot script
 * publishes this on `<html>` before paint, so reading it during a client
 * render is stable; a server render has no document and falls back to `web`.
 */
/** Traffic lights only exist on macOS; other desktops keep a native title bar. */
export function hasTrafficLightChrome(): boolean {
  return (
    isDesktopShell() &&
    typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-volto-platform') === 'darwin'
  );
}

export function isDesktopShell(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-volto-shell') === 'desktop'
  );
}
