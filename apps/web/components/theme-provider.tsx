'use client';

import * as React from 'react';
import { ThemeProvider as NextThemesProvider, useTheme } from 'next-themes';
import { usePreferencesStore } from '@/stores/preferences-store';

/** Cookie cache of the stored theme, so the first server render is right. */
export const THEME_COOKIE = 'volto_theme';

function ThemeProvider({
  children,
  initialTheme = 'system',
  ...props
}: React.ComponentProps<typeof NextThemesProvider> & {
  /** Preference snapshot handed in by the server render (cookie cache). */
  initialTheme?: 'light' | 'dark' | 'system';
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
  const { resolvedTheme, setTheme } = useTheme();

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

      setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
    }

    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [resolvedTheme, setTheme]);

  return null;
}

export { ThemeProvider };
