/**
 * The inline boot script is string-built, so it cannot be type-checked: these
 * specs execute the generated source in a bare scope with a fake document and
 * assert what it publishes, which is what the first frame renders with.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserBootScript,
  LOCALE_ATTRIBUTE,
  readBrowserBoot,
  THEME_ATTRIBUTE,
} from '@/lib/browser-boot';

const realLanguages = navigator.languages;

/** Runs the generated script with `document.cookie` and languages stubbed. */
function runBoot(options: {
  cookie?: string;
  languages?: readonly string[];
  dark?: boolean;
}) {
  const root = document.createElement('html');
  const matchMedia = vi.fn(() => ({ matches: options.dark ?? false }));
  const scope = {
    document: { cookie: options.cookie ?? '', documentElement: root },
    navigator: { languages: options.languages ?? [] },
    window: { matchMedia },
  };
  new Function('document', 'navigator', 'window', browserBootScript())(
    scope.document,
    scope.navigator,
    scope.window,
  );
  return { root, matchMedia };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
  document.documentElement.removeAttribute(LOCALE_ATTRIBUTE);
});

describe('browserBootScript', () => {
  it('boots from the locale cookie and the theme cookie', () => {
    const { root } = runBoot({
      cookie: 'volto_locale=en; volto_theme=dark',
      languages: ['zh-CN'],
    });

    expect(root.getAttribute(LOCALE_ATTRIBUTE)).toBe('en');
    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe('dark');
    expect(root.getAttribute('lang')).toBe('en');
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.style.colorScheme).toBe('dark');
  });

  it('falls back to the browser languages, then to the default', () => {
    const browser = runBoot({ languages: ['fr-FR', 'en-GB'] }).root;
    expect(browser.getAttribute(LOCALE_ATTRIBUTE)).toBe('en');
    expect(browser.getAttribute('lang')).toBe('en');

    const none = runBoot({ languages: ['fr-FR'] }).root;
    expect(none.getAttribute(LOCALE_ATTRIBUTE)).toBe('zh');
    expect(none.getAttribute('lang')).toBe('zh-CN');
  });

  it('follows the system theme when no valid theme cookie exists', () => {
    const dark = runBoot({ cookie: 'volto_theme=sepia', dark: true });
    expect(dark.root.getAttribute(THEME_ATTRIBUTE)).toBe('system');
    expect(dark.root.classList.contains('dark')).toBe(true);
    expect(dark.matchMedia).toHaveBeenCalledWith(
      '(prefers-color-scheme: dark)',
    );

    const light = runBoot({ cookie: 'volto_theme=light', dark: true });
    expect(light.root.classList.contains('dark')).toBe(false);
    expect(light.root.style.colorScheme).toBe('light');
    expect(light.matchMedia).not.toHaveBeenCalled();
  });

  it('defines the runtime config default without overriding an injected one', () => {
    const scope = {
      document: { cookie: '', documentElement: document.createElement('html') },
      navigator: { languages: realLanguages },
      window: {} as { matchMedia?: unknown; __VOLTO_CONFIG__?: unknown },
    };
    const run = () =>
      new Function('document', 'navigator', 'window', browserBootScript())(
        scope.document,
        scope.navigator,
        scope.window,
      );

    run();
    expect(scope.window.__VOLTO_CONFIG__).toEqual({ gatewayUrl: '' });

    scope.window.__VOLTO_CONFIG__ = { gatewayUrl: 'https://gw.example.com' };
    run();
    expect(scope.window.__VOLTO_CONFIG__).toEqual({
      gatewayUrl: 'https://gw.example.com',
    });
  });
});

describe('readBrowserBoot', () => {
  it('reads back what the boot script published', () => {
    document.documentElement.setAttribute(LOCALE_ATTRIBUTE, 'en');
    document.documentElement.setAttribute(THEME_ATTRIBUTE, 'dark');

    expect(readBrowserBoot()).toEqual({ locale: 'en', theme: 'dark' });
  });

  it('defaults when the script never ran', () => {
    expect(readBrowserBoot()).toEqual({ locale: 'zh', theme: 'system' });
  });
});
