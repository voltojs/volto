import { describe, expect, it } from 'vitest';
import { resolveLocale } from '../locale';

describe('resolveLocale', () => {
  it('prefers the stored preference over cookie and header', () => {
    expect(
      resolveLocale({ preference: 'en', cookie: 'zh', acceptLanguage: 'zh-CN' }),
    ).toBe('en');
    expect(
      resolveLocale({ preference: 'zh', cookie: 'en', acceptLanguage: 'en-US' }),
    ).toBe('zh');
  });

  it('falls back to the cookie, then to Accept-Language', () => {
    expect(resolveLocale({ cookie: 'en', acceptLanguage: 'zh-CN' })).toBe('en');
    expect(resolveLocale({ acceptLanguage: 'en-US,en;q=0.9' })).toBe('en');
    expect(resolveLocale({ acceptLanguage: 'zh-CN,zh;q=0.9' })).toBe('zh');
  });

  it('defaults to Chinese when nothing decides', () => {
    expect(resolveLocale({})).toBe('zh');
    expect(resolveLocale({ acceptLanguage: null })).toBe('zh');
    expect(resolveLocale({ acceptLanguage: 'fr-FR' })).toBe('zh');
  });

  it('ignores values the product does not ship', () => {
    expect(resolveLocale({ preference: 'jp', cookie: 'fr', acceptLanguage: 'de' })).toBe(
      'zh',
    );
  });
});
