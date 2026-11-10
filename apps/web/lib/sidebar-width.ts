/**
 * Sidebar width geometry — the single source shared by three audiences:
 * the session store (drag math + persistence), the root layout's pre-paint
 * restore script (runs before any bundle, so it inlines these literals),
 * and the sidebar DOM (styled through the CSS variable, never a React
 * inline px value, so SSR HTML and the first client frame trivially agree).
 */

export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 480;
/** Matches the original fixed `w-72`; also the `:root` fallback in globals.css. */
export const SIDEBAR_WIDTH_DEFAULT = 288;

export const SIDEBAR_WIDTH_KEY = 'volto.sidebar.width';
export const SIDEBAR_WIDTH_CSS_VAR = '--volto-sidebar-width';

export function clampSidebarWidth(n: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(n)));
}

/** Persisted width, clamped; the default when unset or unreadable. */
export function loadSidebarWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_WIDTH_DEFAULT;
  const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? clampSidebarWidth(n) : SIDEBAR_WIDTH_DEFAULT;
}

/** Publish a width to the document; the sidebar renders via the variable. */
export function applySidebarWidthVar(width: number): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty(
    SIDEBAR_WIDTH_CSS_VAR,
    `${width}px`,
  );
}

/**
 * Source of the blocking inline script in the layout head. It runs during
 * HTML parsing — before the first paint of the sidebar markup further down
 * the stream — so the persisted width is what the user sees first: no
 * default-width frame, no hydration comparison (both sides render the same
 * `var(...)` reference), no post-mount jump. Values are inlined because the
 * script executes before any module bundle exists.
 */
export function sidebarWidthRestoreScript(): string {
  return (
    `try{var w=parseInt(localStorage.getItem('${SIDEBAR_WIDTH_KEY}')||'',10);` +
    `if(w>=${SIDEBAR_WIDTH_MIN}&&w<=${SIDEBAR_WIDTH_MAX})` +
    `document.documentElement.style.setProperty('${SIDEBAR_WIDTH_CSS_VAR}',w+'px')` +
    `}catch(e){}`
  );
}
