'use client';

import * as React from 'react';
import { ThemeProvider as NextThemesProvider, useTheme } from 'next-themes';
import { usePreferencesStore } from '@/stores/preferences-store';
import { THEME_COOKIE, type ThemePreference } from '@/lib/theme-preference';

// The cookie and the accepted values live in `@/lib/theme-preference`, free
// of store imports, so the pre-paint boot script can share them.
export {
  THEME_COOKIE,
  THEME_VALUES,
  isThemePreference,
  type ThemePreference,
} from '@/lib/theme-preference';

function ThemeProvider({
  children,
  initialTheme = 'system',
  ...props
}: React.ComponentProps<typeof NextThemesProvider> & {
  /** Preference the page booted with (from the `volto_theme` cookie). */
  initialTheme?: ThemePreference;
}) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme={initialTheme}
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      <ThemePreferenceSync />
      <ThemeHotkey />
      {children}
    </NextThemesProvider>
  );
}

/**
 * The single way to change the theme: flip next-themes' class, store the
 * preference, and refresh the server-render cookie.
 *
 * Writing the preference is not optional — without it `ThemePreferenceSync`
 * sees the stored (old) value disagreeing with the new class and puts it
 * straight back, which reads as the toggle "flashing" and doing nothing.
 */
export function useThemePreference(): readonly [
  ThemePreference | undefined,
  (next: ThemePreference) => void,
] {
  const { theme, setTheme } = useTheme();
  const save = usePreferencesStore((s) => s.save);
  const set = React.useCallback(
    (next: ThemePreference) => {
      setTheme(next);
      save({ theme: next });
      document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    },
    [save, setTheme],
  );
  return [theme as ThemePreference | undefined, set] as const;
}

/**
 * The gateway preference is the source of truth; next-themes only keeps the
 * rendered class in step. Once the preferences arrive (Sidebar loads them),
 * a value that disagrees with the cached one wins.
 */
function ThemePreferenceSync() {
  const { theme, setTheme } = useTheme();
  const stored = usePreferencesStore((s) => s.preferences.theme);

  React.useEffect(() => {
    if (stored === undefined || stored === theme) return;
    setTheme(stored);
  }, [stored, theme, setTheme]);

  return null;
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

function ThemeHotkey() {
  const { resolvedTheme } = useTheme();
  const [, setThemePreference] = useThemePreference();

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat) {
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (event.key.toLowerCase() !== 'd') {
        return;
      }

      if (isTypingTarget(event.target)) {
        return;
      }

      setThemePreference(resolvedTheme === 'dark' ? 'light' : 'dark');
    }

    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [resolvedTheme, setThemePreference]);

  return null;
}

export { ThemeProvider };
