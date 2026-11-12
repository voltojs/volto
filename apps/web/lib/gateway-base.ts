/**
 * Where the browser looks for the gateway, resolved once at runtime.
 *
 * An exported build is plain static files served next to (or behind) the
 * gateway, so its address is deployment data, not build data: a build-time
 * constant would bake one deployment's path into every copy. The order is
 *
 * 1. `localStorage["volto.gatewayUrl"]` — an operator override on this browser
 *    (checked first so it can rescue a deployment whose config file is wrong),
 * 2. `window.__VOLTO_CONFIG__.gatewayUrl` — the deployment's config script
 *    (`public/volto-config.js`, loadable from the head before the app shell),
 * 3. `DEV_DEFAULT`.
 *
 * The result is cached on first use; `resetGatewayBaseForTest` is the only
 * invalidator, so nothing needs per-request `localStorage` reads.
 */

declare global {
  /** Set by `public/volto-config.js` (or the same default in browser-boot). */
  interface Window {
    __VOLTO_CONFIG__?: { gatewayUrl?: string };
  }
}

/** localStorage key of the per-browser override. */
export const GATEWAY_URL_KEY = 'volto.gatewayUrl';

/**
 * Fallback when neither source names an address. `next dev` keeps the
 * browser-visible `/gateway` prefix its rewrite table proxies (see
 * next.config.ts); every other build — the exported one included — is
 * same-origin (`""`), where the static host serves the API directly.
 */
const DEV_DEFAULT = process.env.NODE_ENV === 'development' ? '/gateway' : '';

/** Strips surrounding whitespace and trailing slashes; `"/"` becomes `""`. */
function normalize(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? '';
  return trimmed === '/' ? '' : trimmed.replace(/\/+$/, '');
}

/**
 * The browser globals are absent outside a DOM (a node-environment unit test,
 * a server-side import of one of these modules), so both readers degrade to
 * "nothing configured" instead of throwing. Storage can also be disabled
 * (private mode, embedded webview), which reads the same way.
 */
function readLocalOverride(): string {
  try {
    return normalize(globalThis.localStorage?.getItem(GATEWAY_URL_KEY));
  } catch {
    return '';
  }
}

function readInjectedConfig(): string {
  return normalize(
    (globalThis as typeof globalThis & { window?: Window }).window
      ?.__VOLTO_CONFIG__?.gatewayUrl,
  );
}

function resolveGatewayBase(): string {
  return readLocalOverride() || readInjectedConfig() || DEV_DEFAULT;
}

let cached: string | null = null;

/** The gateway base URL (`""` means same origin). Resolved once, then cached. */
export function getGatewayBase(): string {
  cached ??= resolveGatewayBase();
  return cached;
}

/** Absolute-or-relative URL of `path` on the gateway. Never yields `//`. */
export function gatewayUrl(path: string): string {
  const base = getGatewayBase();
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/** Drops the memo so the next call re-reads `localStorage` and the config. */
export function resetGatewayBaseForTest(): void {
  cached = null;
}
