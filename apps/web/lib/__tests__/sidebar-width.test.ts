// @vitest-environment jsdom
/**
 * The pre-paint restore script inlined into the layout head. Executed here
 * via `new Function` — the same "plain source, no bundle" contract the
 * browser runs — so its clamp/parse behaviour is genuinely load-bearing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  SIDEBAR_WIDTH_CSS_VAR,
  SIDEBAR_WIDTH_KEY,
  sidebarWidthRestoreScript,
} from '../sidebar-width';

function runRestoreScript(): void {
  // eslint-disable-next-line no-new-func -- mirrors the inline <script> pass
  new Function(sidebarWidthRestoreScript())();
}

afterEach(() => {
  localStorage.removeItem(SIDEBAR_WIDTH_KEY);
  document.documentElement.style.removeProperty(SIDEBAR_WIDTH_CSS_VAR);
});

describe('sidebarWidthRestoreScript', () => {
  it('publishes an in-range persisted width into the CSS variable', () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, '374');
    runRestoreScript();
    expect(
      document.documentElement.style.getPropertyValue(SIDEBAR_WIDTH_CSS_VAR),
    ).toBe('374px');
  });

  it('leaves the CSS default standing for out-of-range or corrupt values', () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, '999');
    runRestoreScript();
    expect(
      document.documentElement.style.getPropertyValue(SIDEBAR_WIDTH_CSS_VAR),
    ).toBe('');

    localStorage.setItem(SIDEBAR_WIDTH_KEY, 'abc');
    runRestoreScript();
    expect(
      document.documentElement.style.getPropertyValue(SIDEBAR_WIDTH_CSS_VAR),
    ).toBe('');
  });

  it('survives a throwing localStorage (private mode)', () => {
    // A storage getter that throws must not break parsing of the document:
    // the script's try/catch swallows it.
    const original = window.localStorage;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    try {
      expect(() => runRestoreScript()).not.toThrow();
    } finally {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: original,
      });
    }
  });
});
