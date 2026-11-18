/**
 * The desktop passes the theme in the URL. next-themes still initialises from
 * `localStorage.theme`, so without a forced theme a stored dark value wins
 * after mount. These specs pin both halves of that behaviour.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

import { ThemeProvider } from '@/components/theme-provider';
import { forcedThemeValue } from '@/lib/theme-preference';

function stubMatchMedia(matches = false) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.style.colorScheme = '';
  stubMatchMedia(false);
});

describe('forcedThemeValue', () => {
  it('resolves system and passes explicit themes through', () => {
    expect(forcedThemeValue('light', true, true)).toBe('light');
    expect(forcedThemeValue('dark', true, false)).toBe('dark');
    expect(forcedThemeValue('system', true, true)).toBe('dark');
    expect(forcedThemeValue('system', true, false)).toBe('light');
    expect(forcedThemeValue('light', false, true)).toBeUndefined();
  });
});

describe('ThemeProvider forced theme', () => {
  it('keeps the URL theme when localStorage says dark', async () => {
    localStorage.setItem('theme', 'dark');

    render(
      <ThemeProvider initialTheme="light" lockTheme forcedTheme="light">
        <div />
      </ThemeProvider>,
    );

    await waitFor(() =>
      expect(document.documentElement.classList.contains('dark')).toBe(false),
    );
  });

  it('demonstrates the stored value winning without a forced theme', async () => {
    localStorage.setItem('theme', 'dark');

    render(
      <ThemeProvider initialTheme="light" lockTheme>
        <div />
      </ThemeProvider>,
    );

    await waitFor(() =>
      expect(document.documentElement.classList.contains('dark')).toBe(true),
    );
  });
});
