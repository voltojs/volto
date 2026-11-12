/**
 * Theme constants — no React, no store imports.
 *
 * They live apart from the provider component so the pre-paint boot script
 * (`lib/browser-boot`) and the layout can import them without pulling in the
 * preferences store and, transitively, the whole transport layer: that
 * chain (`theme-provider` → `preferences-store` → `lib/preferences` →
 * `agent-config` → `lib/approvals` → `@volto/sdk/sse` → `@volto/core`)
 * closes a cycle back into the layout's own modules, and a cycle read too
 * early hands back `undefined` where a constant was expected.
 */

/** Cookie cache of the stored theme, readable by the boot script before paint. */
export const THEME_COOKIE = 'volto_theme';

/** Every theme the product renders; anything else falls back to `system`. */
export const THEME_VALUES = ['light', 'dark', 'system'] as const;

/** A theme the user can pick. */
export type ThemePreference = (typeof THEME_VALUES)[number];

/** Narrows an arbitrary value (cookie, attribute) to a settable theme. */
export function isThemePreference(value: unknown): value is ThemePreference {
  return (THEME_VALUES as readonly unknown[]).includes(value);
}
