/**
 * Navigation policy for the two views. Pure so both rules are unit-tested
 * without Electron: the gateway page may only stay inside the origin it was
 * loaded from, and the local shell page may not leave its own entry document.
 */

/** `true` when `url` belongs to the gateway that is currently loaded. */
export function isAllowedNavigation(gatewayOrigin: string | undefined, url: string): boolean {
  if (url === "about:blank") return true;
  if (gatewayOrigin === undefined) return false;
  try {
    return new URL(url).origin === gatewayOrigin;
  } catch {
    return false;
  }
}

/** `true` when `url` is the local shell document (or its hash/query variant). */
export function isShellNavigationAllowed(entryUrl: string, url: string): boolean {
  if (url === "about:blank") return true;
  try {
    const entry = new URL(entryUrl);
    const target = new URL(url);
    return entry.origin === target.origin && entry.pathname === target.pathname;
  } catch {
    return false;
  }
}